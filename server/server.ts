import { Bonjour } from 'bonjour-service';
import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import selfsigned from 'selfsigned';
import semver from 'semver';
import WebSocket from 'ws';
import cors from 'cors';
import crypto from 'crypto';
import AdmZip from 'adm-zip';

// 디렉토리 생성
const receivedDir = path.join(__dirname, 'received');
const updatesDir = path.join(__dirname, 'updates');
const backupsDir = path.join(updatesDir, 'backups');
const sharedDir = path.join(updatesDir, 'shared');
const chatHistoryPath = path.join(__dirname, 'chat-history.json');
const logPath = path.join(__dirname, 'activity-log.json');
const profilesPath = path.join(__dirname, 'profiles.json');
[receivedDir, updatesDir, backupsDir, sharedDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// 인증서 생성
const keyPath = path.join(__dirname, 'key.pem');
const certPath = path.join(__dirname, 'cert.pem');
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  const pems = selfsigned.generate(null, { days: 365 });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('인증서 생성 완료');
}

// 로컬 IP 가져오기
function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  throw new Error('로컬 IP를 찾을 수 없습니다.');
}

const localIp = getLocalIp();
const port = 8000;
const currentVersion = '1.0.0';

// Express 앱 설정
const app = express();
app.use(cors());
app.use(express.raw({ type: '*/*', limit: '100mb' }));
app.use(express.json({ limit: '10mb' }));

// 기기 목록 및 상태 캐싱
interface Device {
  name: string;
  ip: string;
  port: number;
  status: 'online' | 'offline' | 'idle' | 'dnd';
  version: string;
}
const devices: Device[] = [];
const deviceCache = new Map<string, Device>();

// 사용자 프로필 및 고유 코드
interface UserProfile {
  uniqueId: string;
  nickname: string;
  avatar?: string;
  status: 'online' | 'offline' | 'idle' | 'dnd';
  autoAccept: boolean;
  autoAcceptWhitelist: string[];
  version: string;
}
const profiles: { [ip: string]: UserProfile } = fs.existsSync(profilesPath)
  ? JSON.parse(fs.readFileSync(profilesPath, 'utf8'))
  : {};

// 권한 관리
const authorizedDevices = new Set<string>();
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers['authorization'];
  if (token && authorizedDevices.has(token)) {
    next();
  } else {
    res.status(403).send('권한 없음');
  }
}

// 로그 기록 함수
function logActivity(action: string, details: string) {
  const logs = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
  logs.push({ action, details, timestamp: new Date().toISOString() });
  fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
}

// 성능 모니터링
const performanceMetrics: { [key: string]: number } = {};
function trackPerformance(action: string, startTime: number) {
  const duration = Date.now() - startTime;
  performanceMetrics[action] = (performanceMetrics[action] || 0) + duration;
}

// 프로필 및 상태 업데이트
app.post('/profile', (req, res) => {
  const { ip, nickname, avatar, status, autoAccept, autoAcceptWhitelist, version } = req.body;
  const uniqueId = profiles[ip]?.uniqueId || crypto.randomUUID();
  profiles[ip] = {
    uniqueId,
    nickname,
    avatar: avatar || `https://api.dicebear.com/9.x/initials/svg?seed=${nickname}`,
    status: status || 'online',
    autoAccept: autoAccept ?? false,
    autoAcceptWhitelist: autoAcceptWhitelist ?? [],
    version: version || currentVersion
  };
  fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
  logActivity('profile_update', `IP: ${ip}, 닉네임: ${nickname}, 상태: ${status}, 버전: ${version}`);
  res.json({ uniqueId });
});

// 상태 업데이트 API
app.post('/status', requireAuth, (req, res) => {
  const { ip, status } = req.body;
  if (profiles[ip]) {
    profiles[ip].status = status;
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    logActivity('status_update', `IP: ${ip}, 상태: ${status}`);
    res.send('상태 업데이트 완료');
  } else {
    res.status(404).send('프로필 없음');
  }
});

// 무조건 받기 모드 업데이트 API
app.post('/auto-accept', requireAuth, (req, res) => {
  const { ip, autoAccept, autoAcceptWhitelist } = req.body;
  if (profiles[ip]) {
    profiles[ip].autoAccept = autoAccept;
    profiles[ip].autoAcceptWhitelist = autoAcceptWhitelist ?? profiles[ip].autoAcceptWhitelist;
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    logActivity('auto_accept_update', `IP: ${ip}, 무조건 받기: ${autoAccept}, 허용 목록: ${autoAcceptWhitelist.join(',')}`);
    res.send('무조건 받기 모드 업데이트 완료');
  } else {
    res.status(404).send('프로필 없음');
  }
});

// 기기 목록 API
app.get('/devices', (req, res) => {
  res.json(devices.map(device => ({
    ...device,
    status: profiles[device.ip]?.status || 'offline',
    autoAccept: profiles[device.ip]?.autoAccept || false,
    autoAcceptWhitelist: profiles[device.ip]?.autoAcceptWhitelist || [],
    version: profiles[device.ip]?.version || currentVersion
  })));
});

// P2P 업데이트 요청 API
app.post('/request-peer-update', requireAuth, async (req, res) => {
  const { requesterIp, targetIp, version } = req.body;
  if (profiles[requesterIp]?.status === 'offline') {
    res.status(403).send('오프라인 모드에서는 업데이트 요청 불가');
    return;
  }
  const metadataPath = path.join(updatesDir, 'update-metadata.json');
  if (!fs.existsSync(metadataPath)) {
    res.status(404).send('업데이트 메타데이터 없음');
    return;
  }
  const metadata: UpdateMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.version !== version) {
    res.status(404).send('요청한 버전과 메타데이터 불일치');
    return;
  }
  const filePath = path.join(updatesDir, metadata.file);
  if (!fs.existsSync(filePath)) {
    res.status(404).send('업데이트 파일 없음');
    return;
  }
  logActivity('peer_update_request', `요청자: ${requesterIp}, 대상: ${targetIp}, 버전: ${version}`);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${requesterIp}`)) {
      const cipher = crypto.createCipher('aes-256-cbc', secretKey);
      let encrypted = cipher.update(`업데이트 요청: v${version} (대상: ${targetIp})`, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      client.send(encrypted);
    }
  });
  res.json({ file: metadata.file, version: metadata.version, type: metadata.type, signature: metadata.signature });
});

// 파일 업로드 요청 API
app.post('/upload-request', requireAuth, (req, res) => {
  const { filename, senderIp } = req.body;
  const receiverIp = req.query.ip as string;
  if (profiles[receiverIp]?.status === 'offline') {
    res.status(403).send('오프라인 모드에서는 파일 수신 불가');
    return;
  }
  if (profiles[receiverIp]?.autoAccept && profiles[receiverIp]?.autoAcceptWhitelist.includes(senderIp)) {
    res.json({ autoAccepted: true });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${receiverIp}`)) {
        const cipher = crypto.createCipher('aes-256-cbc', secretKey);
        let encrypted = cipher.update(`파일 ${filename}이(가) 자동 수락되었습니다.`, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        client.send(encrypted);
      }
    });
  } else {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${receiverIp}`)) {
        const cipher = crypto.createCipher('aes-256-cbc', secretKey);
        let encrypted = cipher.update(`파일 요청: ${filename} (보낸이: ${senderIp})`, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        client.send(encrypted);
      }
    });
    res.json({ autoAccepted: false });
  }
});

// 파일 수락 API
app.post('/accept-file', requireAuth, (req, res) => {
  const { filename, senderIp } = req.body;
  logActivity('file_accept', `파일: ${filename}, 보낸이: ${senderIp}`);
  res.send('파일 수락됨');
});

// 파일 거부 API
app.post('/reject-file', requireAuth, (req, res) => {
  const { filename, senderIp } = req.body;
  logActivity('file_reject', `파일: ${filename}, 보낸이: ${senderIp}`);
  res.send('파일 거부됨');
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${senderIp}`)) {
      const cipher = crypto.createCipher('aes-256-cbc', secretKey);
      let encrypted = cipher.update(`파일 ${filename}이(가) 거부되었습니다.`, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      client.send(encrypted);
    }
  });
});

// 파일 업로드 API
const unsupportedExtensions = ['.exe', '.bat', '.sh'];
app.post('/upload', requireAuth, (req, res) => {
  const startTime = Date.now();
  const filename = req.query.filename as string;
  const folder = req.query.folder as string;
  const ip = req.query.ip as string;
  const senderIp = req.query.senderIp as string;
  if (profiles[ip]?.status === 'offline') {
    res.status(403).send('오프라인 모드에서는 파일 수신 불가');
    return;
  }
  if (!filename || /[<>\|]/.test(filename)) {
    res.status(400).send('유효하지 않은 파일 이름');
    return;
  }
  const targetDir = folder ? path.join(sharedDir, folder) : receivedDir;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const filePath = path.join(targetDir, filename);
  if (unsupportedExtensions.some(ext => filename.endsWith(ext))) {
    const zip = new AdmZip();
    zip.addFile(filename, req.body);
    const zipPath = `${filePath}.zip`;
    zip.writeZip(zipPath);
    logActivity('file_upload', `압축 파일: ${filename}.zip, 폴더: ${folder || '없음'}, 보낸이: ${senderIp}`);
    trackPerformance('file_upload', startTime);
    res.send('파일 압축 후 업로드 완료');
    return;
  }
  let receivedBytes = 0;
  const fileStream = fs.createWriteStream(filePath);
  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
    fileStream.write(chunk);
  });
  req.on('end', () => {
    fileStream.end();
    console.log(`파일 수신 완료: ${filename} (${receivedBytes} bytes)`);
    logActivity('file_upload', `파일: ${filename}, 크기: ${receivedBytes} bytes, 폴더: ${folder || '없음'}, 보낸이: ${senderIp}`);
    trackPerformance('file_upload', startTime);
    res.send('파일 업로드 완료');
  });
  req.on('error', (err) => {
    console.error('업로드 오류:', err.message);
    res.status(500).send('업로드 실패');
  });
});

// 공유 폴더 API
app.post('/share-folder', requireAuth, (req, res) => {
  const folderName = req.query.folder as string;
  if (!folderName || /[<>\|]/.test(folderName)) {
    res.status(400).send('유효하지 않은 폴더 이름');
    return;
  }
  const folderPath = path.join(sharedDir, folderName);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  logActivity('share_folder', `폴더: ${folderName}`);
  res.send('공유 폴더 생성 완료');
});

// 업데이트 메타데이터
interface UpdateMetadata {
  version: string;
  type: 'main' | 'custom';
  file: string;
  signature: string;
}
const metadataPath = path.join(updatesDir, 'update-metadata.json');
const mainDeveloperPublicKey = 'main-developer-public-key';

// 업데이트 확인 API
app.get('/check-update', (req, res) => {
  try {
    const metadata: UpdateMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    res.json(metadata);
  } catch (error) {
    res.status(404).send('업데이트 메타데이터 없음');
  }
});

// 업데이트 다운로드 API
app.get('/download-update', requireAuth, (req, res) => {
  const startTime = Date.now();
  const file = req.query.file as string;
  const ip = req.query.ip as string;
  if (profiles[ip]?.status === 'offline') {
    res.status(403).send('오프라인 모드에서는 다운로드 불가');
    return;
  }
  const filePath = path.join(updatesDir, file);
  if (fs.existsSync(filePath)) {
    const metadata: UpdateMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const fileContent = fs.readFileSync(filePath);
    const verifier = crypto.createVerify('SHA256');
    verifier.update(fileContent);
    if (metadata.type === 'main' && !verifier.verify(mainDeveloperPublicKey, metadata.signature, 'hex')) {
      res.status(403).send('서명 검증 실패');
      return;
    }
    const backupPath = path.join(backupsDir, `backup-${metadata.version}.zip`);
    fs.copyFileSync(filePath, backupPath);
    logActivity('update_download', `파일: ${file}, 버전: ${metadata.version}`);
    trackPerformance('update_download', startTime);
    res.download(filePath);
  } else {
    res.status(404).send('파일 없음');
  }
});

// 업데이트 설치 API
app.post('/install-update', requireAuth, (req, res) => {
  const startTime = Date.now();
  const { file, version } = req.body;
  const filePath = path.join(updatesDir, file);
  if (!fs.existsSync(filePath)) {
    res.status(404).send('업데이트 파일 없음');
    return;
  }
  try {
    const zip = new AdmZip(filePath);
    const installDir = path.join(__dirname, 'app');
    zip.extractAllTo(installDir, true);
    profiles[localIp].version = version;
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    logActivity('update_install', `버전: ${version}, 파일: ${file}`);
    trackPerformance('update_install', startTime);
    res.send('업데이트 설치 완료');
    setTimeout(() => {
      console.log('서버 재시작 중...');
      process.exit(0);
    }, 1000);
  } catch (error) {
    console.error('업데이트 설치 오류:', error);
    res.status(500).send('업데이트 설치 실패');
  }
});

// 롤백 API
app.get('/rollback', requireAuth, (req, res) => {
  const startTime = Date.now();
  const version = req.query.version as string;
  const backupPath = path.join(backupsDir, `backup-${version}.zip`);
  if (fs.existsSync(backupPath)) {
    logActivity('rollback', `버전: ${version}`);
    trackPerformance('rollback', startTime);
    res.download(backupPath);
  } else {
    res.status(404).send('백업 파일 없음');
  }
});

// 활동 로그 API
app.get('/logs', (req, res) => {
  if (fs.existsSync(logPath)) {
    res.json(JSON.parse(fs.readFileSync(logPath, 'utf8')));
  } else {
    res.json([]);
  }
});

// HTTPS 서버 시작
const server = https.createServer({
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath)
}, app);

// WebSocket 서버
const secretKey = crypto.randomBytes(32);
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
  const group = req.url?.split('group=')[1] || 'all';
  const ip = req.url?.split('ip=')[1] || 'unknown';
  if (profiles[ip]) {
    profiles[ip].status = 'online';
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
  }
  const pingInterval = setInterval(() => {
    if (ws.isAlive === false) {
      if (profiles[ip]) {
        profiles[ip].status = 'offline';
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
      }
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, 30000);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const decipher = crypto.createDecipher('aes-256-cbc', secretKey);
      let decrypted = decipher.update(message as Buffer, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      console.log(`채팅 수신 (그룹: ${group}): ${decrypted}`);
      const history = fs.existsSync(chatHistoryPath)
        ? JSON.parse(fs.readFileSync(chatHistoryPath, 'utf8'))
        : [];
      history.push({ message: decrypted, timestamp: new Date().toISOString() });
      fs.writeFileSync(chatHistoryPath, JSON.stringify(history, null, 2));
      logActivity('chat_message', `메시지: ${decrypted}, 그룹: ${group}`);
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && (group === 'all' || client.url?.includes(group))) {
          const cipher = crypto.createCipher('aes-256-cbc', secretKey);
          let encrypted = cipher.update(decrypted, 'utf8', 'hex');
          encrypted += cipher.final('hex');
          client.send(encrypted);
        }
      });
    } catch (error) {
      console.error('채팅 처리 오류:', error);
    }
  });

  ws.on('error', (error) => console.error('WebSocket 오류:', error));
});

// 서버 시작
server.listen(port, () => {
  console.log(`HTTPS 서버 시작: https://${localIp}:${port}`);
});

// bonjour-service로 mDNS 설정
const bonjour = new Bonjour();
bonjour.publish({
  name: `NTP-${os.hostname()}`,
  type: 'filesharing',
  port,
  host: localIp,
  txt: { version: currentVersion }
});

// 기기 탐지
bonjour.find({ type: 'filesharing' }, (service) => {
  const device: Device = {
    name: service.name,
    ip: service.addresses?.find(addr => addr.includes('.')) || '',
    port: service.port,
    status: profiles[service.addresses?.find(addr => addr.includes('.')) || '']?.status || 'offline',
    version: service.txt?.version || currentVersion
  };
  if (!deviceCache.has(device.name)) {
    deviceCache.set(device.name, device);
    devices.push(device);
    console.log('기기 발견:', device);
  }
});
setInterval(() => {
  devices.length = 0;
  devices.push(...deviceCache.values());
}, 15000);

// 종료 처리
process.on('SIGINT', () => {
  bonjour.destroy();
  server.close();
  console.log('서버 종료');
  process.exit(0);
});