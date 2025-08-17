import React, { useState, useEffect, useCallback } from 'react';
import { Tab, Tabs, TabList, TabPanel } from 'react-tabs';
import 'react-tabs/style/react-tabs.css';
import { useTranslation } from 'react-i18next';
import WebSocket from 'ws';
import * as WebRTC from 'simple-peer';
import { Buffer } from 'buffer';
import crypto from 'crypto';
import { saveAs } from 'file-saver';
import './App.css';

// 타입 정의
interface Device {
  name: string;
  ip: string;
  port: number;
  status: 'online' | 'offline';
  version: string;
}
interface Profile {
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
interface UpdateMetadata {
  version: string;
  type: 'main' | 'custom';
  file: string;
  signature: string;
}

// 로컬 IP 가져오기
const getLocalIp = async (): Promise<string> => {
  const interfaces = require('os').networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.') || iface.address.startsWith('25.') || iface.address.startsWith('5.')) {
          return iface.address;
        }
      }
    }
  }
  return '127.0.0.1';
};

const App: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [profile, setProfile] = useState<Profile>({
    uniqueId: crypto.randomUUID(),
    nickname: 'User',
    status: 'online',
    autoAccept: false,
    autoAcceptWhitelist: [],
    version: '1.0.0',
    networkId: '',
    inviteCode: '',
  });
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [chatWs, setChatWs] = useState<WebSocket | null>(null);
  const [chatMessages, setChatMessages] = useState<{ message: string; senderIp: string; timestamp: string; isAudio?: boolean; audioUrl?: string }[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [selectedGroup, setSelectedGroup] = useState<string>('all');
  const [uploadProgress, setUploadProgress] = useState<{ [key: string]: number }>({});
  const [peers, setPeers] = useState<{ [ip: string]: WebRTC.Instance }>({});
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [networkId, setNetworkId] = useState<string>('');
  const [inviteCode, setInviteCode] = useState<string>('');

  // 로컬 저장소에서 설정 로드
  useEffect(() => {
    const loadSettings = async () => {
      const savedProfile = localStorage.getItem('profile');
      const savedTheme = localStorage.getItem('theme');
      const savedNetworkId = localStorage.getItem('networkId');
      const savedInviteCode = localStorage.getItem('inviteCode');
      if (savedProfile) setProfile(JSON.parse(savedProfile));
      if (savedTheme) setTheme(savedTheme as 'light' | 'dark');
      if (savedNetworkId) setNetworkId(savedNetworkId);
      if (savedInviteCode) setInviteCode(savedInviteCode);
    };
    loadSettings();
  }, []);

  // 설정 저장
  const saveSettings = useCallback(() => {
    localStorage.setItem('profile', JSON.stringify(profile));
    localStorage.setItem('theme', theme);
    localStorage.setItem('networkId', networkId);
    localStorage.setItem('inviteCode', inviteCode);
    if (chatWs?.readyState === WebSocket.OPEN) {
      const cipher = crypto.createCipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
      let encrypted = cipher.update(JSON.stringify({ type: 'profile', ...profile, networkId, inviteCode }), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      chatWs.send(encrypted);
    }
  }, [profile, theme, networkId, inviteCode, chatWs]);

  // 초대 코드 생성
  const generateInviteCode = useCallback(() => {
    const code = crypto.randomBytes(8).toString('hex');
    setInviteCode(code);
    setProfile(prev => ({ ...prev, inviteCode: code }));
    saveSettings();
  }, [saveSettings]);

  // WebRTC 연결 설정
  const setupWebRTC = useCallback((receiverIp: string, initiator: boolean = true): { peer: WebRTC.Instance } => {
    const peer = new WebRTC({
      initiator,
      trickle: true,
      config: { iceServers: [] }, // ZeroTier/Hamachi에서는 STUN/TURN 불필요
    });
    peer.on('signal', (data) => {
      if (chatWs?.readyState === WebSocket.OPEN) {
        const cipher = crypto.createCipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
        let encrypted = cipher.update(JSON.stringify({ type: 'webrtc-signal', receiverIp, data }), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        chatWs.send(encrypted);
      }
    });
    peer.on('connect', () => {
      console.log(`WebRTC 연결 성공: ${receiverIp}`);
      setPeers(prev => ({ ...prev, [receiverIp]: peer }));
    });
    peer.on('data', async (data) => {
      const message = JSON.parse(Buffer.from(data).toString());
      if (message.type === 'file') {
        const filename = message.filename;
        const fileData = Buffer.from(message.data, 'base64');
        saveAs(new Blob([fileData]), filename);
        setChatMessages(prev => [...prev, { message: `파일 수신: ${filename}`, senderIp: receiverIp, timestamp: new Date().toISOString(), isAudio: filename.endsWith('.mp3') || filename.endsWith('.wav'), audioUrl: URL.createObjectURL(new Blob([fileData])) }]);
      } else if (message.type === 'update') {
        const filename = message.filename;
        const fileData = Buffer.from(message.data, 'base64');
        saveAs(new Blob([fileData]), filename);
        setChatMessages(prev => [...prev, { message: `업데이트 수신: ${filename}`, senderIp: receiverIp, timestamp: new Date().toISOString() }]);
      }
    });
    peer.on('error', (err) => {
      console.error(`WebRTC 오류: ${receiverIp}`, err);
      setPeers(prev => {
        const newPeers = { ...prev };
        delete newPeers[receiverIp];
        return newPeers;
      });
    });
    return { peer };
  }, [chatWs]);

  // WebSocket 연결
  useEffect(() => {
    const connectWs = async () => {
      setConnectionStatus('connecting');
      const localIp = await getLocalIp();
      const socket = new WebSocket(`ws://${localIp}:8000?group=${selectedGroup}&ip=${localIp}`);
      socket.onopen = () => {
        setConnectionStatus('connected');
        const cipher = crypto.createCipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
        let encrypted = cipher.update(JSON.stringify({ type: 'profile', ...profile, networkId, inviteCode }), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        socket.send(encrypted);
      };
      socket.onmessage = (event) => {
        try {
          const decipher = crypto.createDecipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
          let decrypted = decipher.update(event.data, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          const data = JSON.parse(decrypted);
          switch (data.type) {
            case 'webrtc-signal':
              const peer = peers[data.senderIp] || setupWebRTC(data.senderIp, false).peer;
              peer.signal(data.data);
              break;
            case 'chat':
              setChatMessages(prev => [...prev, { message: data.message, senderIp: data.senderIp, timestamp: data.timestamp }]);
              break;
            case 'file-request':
              if (profile.autoAccept && profile.autoAcceptWhitelist.includes(data.senderIp)) {
                setupWebRTC(data.senderIp);
                alert(t('file_auto_accepted', { name: data.filename }));
              } else {
                if (window.confirm(t('file_request_received', { name: data.filename, sender: data.senderIp }))) {
                  setupWebRTC(data.senderIp);
                }
              }
              break;
            case 'file-auto-accepted':
              setupWebRTC(data.senderIp);
              alert(t('file_auto_accepted', { name: data.filename }));
              break;
            case 'update-request':
              const metadata = JSON.parse(localStorage.getItem('update-metadata') || '{}');
              if (metadata.version === data.version) {
                const { peer } = setupWebRTC(data.senderIp);
                peer.on('connect', () => {
                  const fileData = require('fs').readFileSync(`./updates/${metadata.file}`);
                  peer.send(JSON.stringify({ type: 'update', filename: metadata.file, data: Buffer.from(fileData).toString('base64') }));
                });
              }
              break;
            case 'invite-request':
              if (profile.inviteCode === data.code) {
                profiles[data.senderIp] = { ...profiles[data.senderIp], status: 'online' };
                alert(t('invite_accepted', { ip: data.senderIp }));
              }
              break;
          }
        } catch (error) {
          console.error('메시지 복호화 오류:', error);
        }
      };
      socket.onclose = () => setConnectionStatus('disconnected');
      socket.onerror = () => setConnectionStatus('disconnected');
      setChatWs(socket);
    };
    connectWs();
    return () => chatWs?.close();
  }, [selectedGroup, profile, peers, setupWebRTC, networkId, inviteCode, t]);

  // mDNS 기기 탐지
  useEffect(() => {
    const Bonjour = require('bonjour-service').Bonjour;
    const bonjour = new Bonjour();
    bonjour.find({ type: 'filesharing' }, (service: any) => {
      const device: Device = {
        name: service.name,
        ip: service.addresses?.find((addr: string) => addr.includes('.')) || '',
        port: service.port,
        status: service.txt?.status || 'offline',
        version: service.txt?.version || '1.0.0',
      };
      setDevices(prev => {
        const newDevices = prev.filter(d => d.ip !== device.ip);
        return [...newDevices, device];
      });
    });
    return () => bonjour.destroy();
  }, []);

  // 파일 선택 및 전송
  const selectFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedDevice || profile.status === 'offline') {
      alert(t('select_device_or_offline'));
      return;
    }
    const file = e.target.files?.[0];
    if (!file || /[<>\|]/.test(file.name)) {
      alert(t('invalid_filename', { name: file?.name }));
      return;
    }
    if (chatWs?.readyState === WebSocket.OPEN) {
      const cipher = crypto.createCipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
      let encrypted = cipher.update(JSON.stringify({ type: 'file-request', filename: file.name, receiverIp: selectedDevice.ip }), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      chatWs.send(encrypted);
      const { peer } = setupWebRTC(selectedDevice.ip);
      peer.on('connect', () => {
        const reader = new FileReader();
        reader.onload = () => {
          const chunkSize = 64 * 1024;
          const fileData = Buffer.from(reader.result as ArrayBuffer);
          let offset = 0;
          const sendChunk = () => {
            const chunk = fileData.slice(offset, offset + chunkSize);
            peer.send(JSON.stringify({ type: 'file', filename: file.name, data: chunk.toString('base64') }));
            setUploadProgress(prev => ({ ...prev, [file.name]: Math.round((offset / fileData.length) * 100) }));
            offset += chunkSize;
            if (offset < fileData.length) {
              setTimeout(sendChunk, 10);
            } else {
              alert(t('file_upload_p2p_success', { name: file.name }));
              setUploadProgress(prev => {
                const newProgress = { ...prev };
                delete newProgress[file.name];
                return newProgress;
              });
            }
          };
          sendChunk();
        };
        reader.readAsArrayBuffer(file);
      });
    }
  }, [selectedDevice, profile.status, chatWs, setupWebRTC, t]);

  // 설정 탭
  const SettingsTab: React.FC = () => (
    <div className="tab-content">
      <h2>{t('settings')}</h2>
      <label>{t('nickname')}</label>
      <input
        type="text"
        value={profile.nickname}
        onChange={(e) => setProfile(prev => ({ ...prev, nickname: e.target.value }))}
        className="input"
      />
      <label>{t('status')}</label>
      <input
        type="checkbox"
        checked={profile.status === 'online'}
        onChange={(e) => setProfile(prev => ({ ...prev, status: e.target.checked ? 'online' : 'offline' }))}
      />
      <label>{t('auto_accept')}</label>
      <input
        type="checkbox"
        checked={profile.autoAccept}
        onChange={(e) => setProfile(prev => ({ ...prev, autoAccept: e.target.checked }))}
      />
      <label>{t('auto_accept_whitelist')}</label>
      <input
        type="text"
        value={profile.autoAcceptWhitelist.join(',')}
        onChange={(e) => setProfile(prev => ({ ...prev, autoAcceptWhitelist: e.target.value.split(',').map(ip => ip.trim()) }))}
        placeholder={t('enter_ips')}
        className="input"
      />
      <label>{t('theme')}</label>
      <div className="button-group">
        <button onClick={() => setTheme('light')}>{t('light')}</button>
        <button onClick={() => setTheme('dark')}>{t('dark')}</button>
      </div>
      <label>{t('language')}</label>
      <div className="button-group">
        <button onClick={() => i18n.changeLanguage('ko')}>한국어</button>
        <button onClick={() => i18n.changeLanguage('en')}>English</button>
      </div>
      <label>{t('network_id')}</label>
      <input
        type="text"
        value={networkId}
        onChange={(e) => setNetworkId(e.target.value)}
        placeholder={t('enter_network_id')}
        className="input"
      />
      <label>{t('invite_code')}</label>
      <input
        type="text"
        value={inviteCode}
        onChange={(e) => setInviteCode(e.target.value)}
        placeholder={t('enter_invite_code')}
        className="input"
      />
      <button onClick={generateInviteCode}>{t('generate_invite_code')}</button>
      <p>{t('npcap_info')}</p>
      <button onClick={saveSettings}>{t('save_settings')}</button>
    </div>
  );

  // 기기 목록 탭
  const DeviceListTab: React.FC = () => (
    <div className="tab-content">
      <h2>{t('devices')}</h2>
      <ul>
        {devices.map(device => (
          <li
            key={device.ip}
            className={selectedDevice?.ip === device.ip ? 'selected' : ''}
            onClick={() => setSelectedDevice(device)}
          >
            {device.name} ({device.ip}:{device.port}, {t(device.status)}, v{device.version})
          </li>
        ))}
      </ul>
    </div>
  );

  // 채팅 탭
  const ChatTab: React.FC = () => (
    <div className="tab-content">
      <h2>{t('chat')}</h2>
      <input
        type="text"
        value={selectedGroup}
        onChange={(e) => setSelectedGroup(e.target.value)}
        placeholder={t('group_all')}
        className="input"
      />
      <div className="chat-messages">
        {chatMessages.map((msg, index) => (
          <div key={index} className="message">
            <span>[{msg.senderIp} - {msg.timestamp}]: {msg.message}</span>
            {msg.isAudio && (
              <audio controls src={msg.audioUrl} />
            )}
          </div>
        ))}
      </div>
      <input
        type="text"
        onKeyPress={(e) => {
          if (e.key === 'Enter' && chatWs?.readyState === WebSocket.OPEN) {
            const message = e.currentTarget.value;
            const cipher = crypto.createCipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
            let encrypted = cipher.update(JSON.stringify({ type: 'chat', message }), 'utf8', 'hex');
            encrypted += cipher.final('hex');
            chatWs.send(encrypted);
            e.currentTarget.value = '';
          }
        }}
        placeholder={t('enter_message')}
        className="input"
      />
    </div>
  );

  // 파일 전송 탭
  const FileTab: React.FC = () => (
    <div className="tab-content">
      <h2>{t('file_drop')}</h2>
      <input type="file" onChange={selectFile} />
      {Object.entries(uploadProgress).map(([name, progress]) => (
        <div key={name}>{name}: {progress}%</div>
      ))}
    </div>
  );

  return (
    <div className={`app ${theme}`}>
      <div className="status">{t(`connection_${connectionStatus}`)}</div>
      <Tabs>
        <TabList>
          <Tab>{t('settings')}</Tab>
          <Tab>{t('devices')}</Tab>
          <Tab>{t('chat')}</Tab>
          <Tab>{t('file_drop')}</Tab>
        </TabList>
        <TabPanel>
          <SettingsTab />
        </TabPanel>
        <TabPanel>
          <DeviceListTab />
        </TabPanel>
        <TabPanel>
          <ChatTab />
        </TabPanel>
        <TabPanel>
          <FileTab />
        </TabPanel>
      </Tabs>
    </div>
  );
};

export default App;