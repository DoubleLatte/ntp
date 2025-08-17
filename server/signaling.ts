import { Bonjour } from 'bonjour-service';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// 디렉토리 설정
const receivedDir = path.join(__dirname, 'received');
const updatesDir = path.join(__dirname, 'updates');
const backupsDir = path.join(updatesDir, 'backups');
const sharedDir = path.join(updatesDir, 'shared');
const chatHistoryPath = path.join(__dirname, 'chat-history.json');
const logPath = path.join(__dirname, 'activity-log.json');
const profilesPath = path.join(__dirname, 'profiles.json');
[receivedDir, updatesDir, backupsDir, sharedDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 로컬 IP 가져오기
function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.') || iface.address.startsWith('25.') || iface.address.startsWith('5.')) {
          return iface.address;
        }
      }
    }
  }
  throw new Error('로컬 IP를 찾을 수 없습니다.');
}

const localIp = getLocalIp();
const port = 8000;
const currentVersion = '1.0.0';
const secretKey = crypto.randomBytes(32);

// 기기 및 프로필 관리
interface Device {
  name: string;
  ip: string;
  port: number;
  status: 'online' | 'offline';
  version: string;
}
interface UserProfile {
  uniqueId: string;
  nickname: string;
  avatar?: string;
  status: 'online' | 'offline';
  autoAccept: boolean;
  autoAcceptWhitelist: string[];
  version: string;
  networkId?: string;
  inviteCode?: string;
}
const devices: Device[] = [];
const deviceCache = new Map<string, Device>();
const profiles: { [ip: string]: UserProfile } = fs.existsSync(profilesPath)
  ? JSON.parse(fs.readFileSync(profilesPath, 'utf8'))
  : {};

// 로그 기록
function logActivity(action: string, details: string) {
  const logs = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
  logs.push({ action, details, timestamp: new Date().toISOString() });
  fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
}

// WebSocket 서버
const wss = new WebSocket.Server({ port });
wss.on('connection', (ws, req) => {
  const group = req.url?.split('group=')[1] || 'all';
  const ip = req.url?.split('ip=')[1] || 'unknown';
  if (profiles[ip]) {
    profiles[ip].status = 'online';
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
  }
  ws.isAlive = true;
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
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', async (message) => {
    try {
      const decipher = crypto.createDecipher('aes-256-cbc', secretKey);
      let decrypted = decipher.update(message as Buffer, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      const data = JSON.parse(decrypted);

      switch (data.type) {
        case 'webrtc-signal':
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${data.receiverIp}`)) {
              const cipher = crypto.createCipher('aes-256-cbc', secretKey);
              let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
              encrypted += cipher.final('hex');
              client.send(encrypted);
            }
          });
          break;
        case 'chat':
          const history = fs.existsSync(chatHistoryPath)
            ? JSON.parse(fs.readFileSync(chatHistoryPath, 'utf8'))
            : [];
          history.push({ message: data.message, senderIp: ip, timestamp: new Date().toISOString() });
          fs.writeFileSync(chatHistoryPath, JSON.stringify(history, null, 2));
          logActivity('chat_message', `메시지: ${data.message}, 그룹: ${group}`);
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && (group === 'all' || client.url?.includes(group))) {
              const cipher = crypto.createCipher('aes-256-cbc', secretKey);
              let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
              encrypted += cipher.final('hex');
              client.send(encrypted);
            }
          });
          break;
        case 'profile':
          profiles[ip] = {
            uniqueId: profiles[ip]?.uniqueId || crypto.randomUUID(),
            nickname: data.nickname,
            avatar: data.avatar,
            status: data.status || 'online',
            autoAccept: data.autoAccept ?? false,
            autoAcceptWhitelist: data.autoAcceptWhitelist ?? [],
            version: data.version || currentVersion,
            networkId: data.networkId,
            inviteCode: data.inviteCode,
          };
          fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
          logActivity('profile_update', `IP: ${ip}, 닉네임: ${data.nickname}, 네트워크 ID: ${data.networkId}, 초대 코드: ${data.inviteCode}`);
          break;
        case 'file-request':
          if (profiles[data.receiverIp]?.autoAccept && profiles[data.receiverIp]?.autoAcceptWhitelist.includes(ip)) {
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${data.receiverIp}`)) {
                const cipher = crypto.createCipher('aes-256-cbc', secretKey);
                let encrypted = cipher.update(JSON.stringify({ type: 'file-auto-accepted', filename: data.filename, senderIp: ip }), 'utf8', 'hex');
                encrypted += cipher.final('hex');
                client.send(encrypted);
              }
            });
          } else {
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${data.receiverIp}`)) {
                const cipher = crypto.createCipher('aes-256-cbc', secretKey);
                let encrypted = cipher.update(JSON.stringify({ type: 'file-request', filename: data.filename, senderIp: ip }), 'utf8', 'hex');
                encrypted += cipher.final('hex');
                client.send(encrypted);
              }
            });
          }
          break;
        case 'update-request':
          const metadataPath = path.join(updatesDir, 'update-metadata.json');
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            if (metadata.version === data.version) {
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${data.receiverIp}`)) {
                  const cipher = crypto.createCipher('aes-256-cbc', secretKey);
                  let encrypted = cipher.update(JSON.stringify({ type: 'update-response', metadata, senderIp: ip }), 'utf8', 'hex');
                  encrypted += cipher.final('hex');
                  client.send(encrypted);
                }
              });
            }
          }
          break;
        case 'invite-request':
          if (profiles[data.receiverIp]?.inviteCode === data.code) {
            profiles[data.senderIp] = { ...profiles[data.senderIp], status: 'online' };
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.url?.includes(`ip=${data.senderIp}`)) {
                const cipher = crypto.createCipher('aes-256-cbc', secretKey);
                let encrypted = cipher.update(JSON.stringify({ type: 'invite-accepted', receiverIp: ip }), 'utf8', 'hex');
                encrypted += cipher.final('hex');
                client.send(encrypted);
              }
            });
            logActivity('invite_accepted', `IP: ${data.senderIp}, 초대 코드: ${data.code}`);
          }
          break;
      }
    } catch (error) {
      console.error('메시지 처리 오류:', error);
    }
  });

  ws.on('error', (error) => console.error('WebSocket 오류:', error));
  ws.on('close', () => clearInterval(pingInterval));
});

// mDNS 설정
const bonjour = new Bonjour();
bonjour.publish({
  name: `NTP-${os.hostname()}`,
  type: 'filesharing',
  port,
  host: localIp,
  txt: { version: currentVersion }
});

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
  wss.close();
  console.log('서버 종료');
  process.exit(0);
});