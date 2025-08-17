import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios, { CancelTokenSource } from 'axios';
import { useDropzone } from 'react-dropzone';
import semver from 'semver';
import { useHotkeys } from 'react-hotkeys-hook';
import { useTranslation } from 'react-i18next';
import Picker from 'emoji-picker-react';
import './App.css';

interface Device {
  name: string;
  ip: string;
  port: number;
  status: 'online' | 'offline' | 'idle' | 'dnd';
  autoAccept: boolean;
  autoAcceptWhitelist: string[];
  version: string;
}

interface UpdateMetadata {
  version: string;
  type: 'main' | 'custom';
  file: string;
  signature: string;
}

interface ChatMessage {
  message: string;
  timestamp: string;
  sender: string;
  reactions: { emoji: string; count: number; users: string[] }[];
}

interface LogEntry {
  action: string;
  details: string;
  timestamp: string;
}

interface UserProfile {
  uniqueId: string;
  nickname: string;
  avatar?: string;
  status: 'online' | 'offline' | 'idle' | 'dnd';
  autoAccept: boolean;
  autoAcceptWhitelist: string[];
  version: string;
}

const App: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [update, setUpdate] = useState<UpdateMetadata | null>(null);
  const [currentVersion] = useState('1.0.0');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatWs, setChatWs] = useState<WebSocket | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ [key: string]: number }>({});
  const [downloadProgress, setDownloadProgress] = useState<{ [key: string]: number }>({});
  const [cancelTokens, setCancelTokens] = useState<{ [key: string]: CancelTokenSource }>({});
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [profile, setProfile] = useState<UserProfile>({
    uniqueId: '',
    nickname: 'User',
    status: 'online',
    autoAccept: false,
    autoAcceptWhitelist: [],
    version: currentVersion
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [sharedFolder, setSharedFolder] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('connected');
  const [fileRequests, setFileRequests] = useState<{ filename: string; senderIp: string }[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [showProfileCard, setShowProfileCard] = useState<string | null>(null);
  const localIp = '192.168.1.100';
  const chatWindowRef = useRef<HTMLDivElement>(null);

  // 프로필 초기화
  useEffect(() => {
    const initProfile = async () => {
      try {
        const response = await axios.post(
          'https://localhost:8000/profile',
          { ip: localIp, nickname: 'User', avatar: '', status: 'online', autoAccept: false, autoAcceptWhitelist: [], version: currentVersion },
          { httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }) }
        );
        setProfile(response.data);
      } catch (error) {
        console.error('프로필 초기화 오류:', error);
      }
    };
    if (!profile.uniqueId) initProfile();
  }, [profile.uniqueId]);

  // 상태 업데이트
  const toggleStatus = async (newStatus: 'online' | 'offline' | 'idle' | 'dnd') => {
    try {
      await axios.post(
        'https://localhost:8000/status',
        { ip: localIp, status: newStatus },
        { httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }) }
      );
      setProfile(prev => ({ ...prev, status: newStatus }));
    } catch (error) {
      console.error('상태 업데이트 오류:', error);
    }
  };

  // 무조건 받기 모드 및 허용 목록 업데이트
  const updateAutoAccept = async (autoAccept: boolean, autoAcceptWhitelist: string[]) => {
    try {
      await axios.post(
        'https://localhost:8000/auto-accept',
        { ip: localIp, autoAccept, autoAcceptWhitelist },
        { httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }) }
      );
      setProfile(prev => ({ ...prev, autoAccept, autoAcceptWhitelist }));
    } catch (error) {
      console.error('무조건 받기 모드 업데이트 오류:', error);
    }
  };

  // 허용 목록 토글
  const toggleWhitelist = (deviceIp: string) => {
    const newWhitelist = profile.autoAcceptWhitelist.includes(deviceIp)
      ? profile.autoAcceptWhitelist.filter(ip => ip !== deviceIp)
      : [...profile.autoAcceptWhitelist, deviceIp];
    updateAutoAccept(profile.autoAccept, newWhitelist);
  };

  // 기기 목록 가져오기 및 P2P 업데이트 확인
  useEffect(() => {
    const fetchDevices = async () => {
      try {
        const response = await axios.get('https://localhost:8000/devices', {
          httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
        });
        setDevices(response.data);
        const highestVersionDevice = response.data.reduce((highest: Device | null, device: Device) => {
          if (!highest || semver.gt(device.version, highest.version)) {
            return device;
          }
          return highest;
        }, null);
        if (highestVersionDevice && semver.gt(highestVersionDevice.version, currentVersion)) {
          requestPeerUpdate(highestVersionDevice);
        }
      } catch (error) {
        console.error('기기 탐지 오류:', error);
      }
    };
    fetchDevices();
    const interval = setInterval(fetchDevices, 10000);
    return () => clearInterval(interval);
  }, [currentVersion]);

  // P2P 업데이트 요청
  const requestPeerUpdate = async (targetDevice: Device) => {
    try {
      const response = await axios.post(
        `https://${targetDevice.ip}:${targetDevice.port}/request-peer-update`,
        { requesterIp: localIp, targetIp: targetDevice.ip, version: targetDevice.version },
        { headers: { Authorization: 'device-token' }, httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }) }
      );
      const metadata: UpdateMetadata = response.data;
      setUpdate(metadata);
      if (profile.status === 'online') {
        await downloadUpdate(metadata, true);
      }
    } catch (error) {
      console.error('P2P 업데이트 요청 오류:', error);
    }
  };

  // 채팅 기록 로드
  useEffect(() => {
    try {
      const response = axios.get('https://localhost:8000/chat-history', {
        httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
      });
      response.then(res => setMessages(res.data.map((msg: any) => ({ ...msg, reactions: msg.reactions || [] }))));
    } catch (error) {
      console.error('채팅 기록 로드 오류:', error);
    }
  }, []);

  // WebSocket 연결 및 타이핑 인디케이터
  useEffect(() => {
    const connectWs = () => {
      setConnectionStatus('connecting');
      const socket = new WebSocket(`wss://localhost:8000?group=${selectedGroup}&ip=${localIp}`);
      socket.onopen = () => {
        console.log('WebSocket 연결');
        setConnectionStatus('connected');
        socket.send(JSON.stringify({ type: 'auth', token: 'device-token' }));
      };
      socket.onmessage = (event) => {
        try {
          const decipher = crypto.createDecipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
          let decrypted = decipher.update(event.data, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          if (decrypted.includes('파일 요청:') || decrypted.includes('자동 수락') || decrypted.includes('거부되었습니다') || decrypted.includes('업데이트 요청:')) {
            if (Notification.permission === 'granted') {
              new Notification(t('notification'), { body: decrypted });
            }
            if (decrypted.includes('파일 요청:')) {
              const [, filename, senderIp] = decrypted.match(/파일 요청: (.+) \(보낸이: (.+)\)/) || [];
              if (filename && senderIp) {
                setFileRequests(prev => [...prev, { filename, senderIp }]);
              }
            }
            setMessages(prev => [...prev, { message: decrypted, timestamp: new Date().toISOString(), sender: 'system', reactions: [] }]);
          } else if (decrypted.startsWith('typing:')) {
            const [, senderIp] = decrypted.match(/typing:(.+)/) || [];
            if (senderIp) {
              setTypingUsers(prev => [...new Set([...prev, senderIp])]);
              setTimeout(() => setTypingUsers(prev => prev.filter(ip => ip !== senderIp)), 3000);
            }
          } else {
            setMessages(prev => [...prev, { message: decrypted, timestamp: new Date().toISOString(), sender: 'other', reactions: [] }]);
            if (Notification.permission === 'granted') {
              new Notification(t('new_message'), { body: decrypted });
            }
          }
        } catch (error) {
          console.error('메시지 복호화 오류:', error);
        }
      };
      socket.onerror = () => {
        setConnectionStatus('disconnected');
        setTimeout(connectWs, 5000);
      };
      socket.onclose = () => {
        setConnectionStatus('disconnected');
        setTimeout(connectWs, 5000);
      };
      setChatWs(socket);
    };
    connectWs();
    return () => chatWs?.close();
  }, [chatWs, selectedGroup, localIp, t]);

  // 타이핑 이벤트 전송
  const handleTyping = () => {
    if (chatWs && chatInput) {
      const cipher = crypto.createCipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
      let encrypted = cipher.update(`typing:${localIp}`, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      chatWs.send(encrypted);
    }
  };

  // 파일 드롭 처리
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!selectedDevice || profile.status === 'offline') {
      alert(t('select_device_or_offline'));
      return;
    }
    const sortedFiles = acceptedFiles.sort((a, b) => a.size - b.size);
    for (const file of sortedFiles) {
      if (/[<>\|]/.test(file.name)) {
        alert(t('invalid_filename', { name: file.name }));
        continue;
      }
      try {
        const response = await axios.post(
          `https://${selectedDevice.ip}:${selectedDevice.port}/upload-request`,
          { filename: file.name, senderIp: localIp },
          {
            headers: { Authorization: 'device-token' },
            httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
          }
        );
        if (response.data.autoAccepted) {
          await uploadFile(file);
        } else {
          alert(t('file_request_sent', { name: file.name }));
        }
      } catch (error) {
        console.error('파일 요청 오류:', error);
        alert(t('file_request_fail', { name: file.name }));
      }
    }
  }, [selectedDevice, sharedFolder, profile.status, localIp, t]);

  // 파일 업로드 함수
  const uploadFile = async (file: File) => {
    if (!selectedDevice) return;
    const source = axios.CancelToken.source();
    setCancelTokens(prev => ({ ...prev, [file.name]: source }));
    try {
      const startTime = Date.now();
      await axios.post(
        `https://${selectedDevice.ip}:${selectedDevice.port}/upload?filename=${file.name}&folder=${sharedFolder}&ip=${localIp}&senderIp=${localIp}`,
        file,
        {
          headers: { 'Content-Type': 'application/octet-stream', Authorization: 'device-token' },
          httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }),
          cancelToken: source.token,
          onUploadProgress: (progressEvent) => {
            const percent = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
            setUploadProgress(prev => ({ ...prev, [file.name]: percent }));
          }
        }
      );
      alert(t('file_upload_success', { name: file.name }));
      setLogs(prev => [...prev, { action: 'file_upload', details: `${file.name} (${Date.now() - startTime}ms)`, timestamp: new Date().toISOString() }]);
    } catch (error) {
      if (axios.isCancel(error)) {
        console.log(`${file.name} 전송 취소`);
      } else {
        console.error('파일 전송 오류:', error);
        alert(t('file_upload_fail', { name: file.name }));
      }
    }
    setUploadProgress(prev => {
      const newProgress = { ...prev };
      delete newProgress[file.name];
      return newProgress;
    });
  };

  const { getRootProps, getInputProps } = useDropzone({ multiple: true, onDrop, webkitdirectory: true });

  // 파일 전송 취소
  const cancelUpload = useCallback((fileName: string) => {
    if (cancelTokens[fileName]) {
      cancelTokens[fileName].cancel();
      setCancelTokens(prev => {
        const newTokens = { ...prev };
        delete newTokens[fileName];
        return newTokens;
      });
    }
  }, [cancelTokens]);

  // 파일 수락/거부 처리
  const handleFileRequest = async (request: { filename: string; senderIp: string }, accept: boolean) => {
    try {
      if (accept) {
        await axios.post(
          `https://localhost:8000/accept-file`,
          { filename: request.filename, senderIp: request.senderIp },
          { httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }) }
        );
        await uploadFile(new File([await (await fetch(`https://${request.senderIp}:8000/download-update?file=${request.filename}&ip=${localIp}`, {
          headers: { Authorization: 'device-token' },
          agent: new (require('https')).Agent({ rejectUnauthorized: false })
        })).blob()], request.filename));
        alert(t('file_accepted', { name: request.filename }));
      } else {
        await axios.post(
          `https://localhost:8000/reject-file`,
          { filename: request.filename, senderIp: request.senderIp },
          { httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }) }
        );
        alert(t('file_reject_sent', { name: request.filename }));
      }
      setFileRequests(prev => prev.filter(req => req.filename !== request.filename || req.senderIp !== request.senderIp));
    } catch (error) {
      console.error('파일 처리 오류:', error);
      alert(t('file_process_fail', { name: request.filename }));
    }
  };

  // 채팅 전송
  const sendMessage = useCallback(() => {
    if (chatWs && chatInput && !/[<>\|]/.test(chatInput)) {
      const cipher = crypto.createCipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
      let encrypted = cipher.update(chatInput, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      chatWs.send(encrypted);
      setMessages(prev => [...prev, { message: chatInput, timestamp: new Date().toISOString(), sender: localIp, reactions: [] }]);
      setChatInput('');
    }
  }, [chatWs, chatInput, localIp]);

  // 메시지 반응 추가
  const addReaction = (messageIndex: number, emoji: string) => {
    setMessages(prev => {
      const newMessages = [...prev];
      const message = newMessages[messageIndex];
      const reaction = message.reactions.find(r => r.emoji === emoji);
      if (reaction) {
        if (!reaction.users.includes(localIp)) {
          reaction.count += 1;
          reaction.users.push(localIp);
        }
      } else {
        message.reactions.push({ emoji, count: 1, users: [localIp] });
      }
      return newMessages;
    });
  };

  // 채팅 스크롤 최적화
  useEffect(() => {
    const chatRef = chatWindowRef.current;
    if (chatRef) {
      const isAtBottom = chatRef.scrollHeight - chatRef.scrollTop <= chatRef.clientHeight + 100;
      if (isAtBottom) {
        chatRef.scrollTop = chatRef.scrollHeight;
      }
    }
  }, [messages]);

  // 채팅 그룹화
  const groupedMessages = useMemo(() => {
    const filteredMessages = messages.filter(msg =>
      msg.message.toLowerCase().includes(searchQuery.toLowerCase())
    );
    const grouped: ChatMessage[][] = [];
    let currentGroup: ChatMessage[] = [];
    filteredMessages.forEach((msg, index) => {
      if (index === 0 || msg.sender !== filteredMessages[index - 1].sender) {
        if (currentGroup.length) grouped.push(currentGroup);
        currentGroup = [msg];
      } else {
        currentGroup.push(msg);
      }
    });
    if (currentGroup.length) grouped.push(currentGroup);
    return grouped;
  }, [messages, searchQuery]);

  // 업데이트 다운로드 및 설치
  const downloadUpdate = useCallback(async (metadata: UpdateMetadata, autoInstall: boolean) => {
    if (profile.status === 'offline') return;
    try {
      const response = await axios.get(
        `https://localhost:8000/download-update?file=${metadata.file}&ip=${localIp}`,
        {
          responseType: 'arraybuffer',
          httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }),
          onDownloadProgress: (progressEvent) => {
            const percent = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
            setDownloadProgress(prev => ({ ...prev, [metadata.file]: percent }));
          }
        }
      );
      const blob = new Blob([response.data]);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = metadata.file;
      a.click();
      window.URL.revokeObjectURL(url);
      alert(t('update_download_success'));
      setDownloadProgress(prev => {
        const newProgress = { ...prev };
        delete newProgress[metadata.file];
        return newProgress;
      });

      if (autoInstall) {
        const installConfirm = window.confirm(t('install_update_confirm', { version: metadata.version }));
        if (installConfirm) {
          await axios.post(
            'https://localhost:8000/install-update',
            { file: metadata.file, version: metadata.version },
            { httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }) }
          );
          alert(t('update_install_success'));
          setProfile(prev => ({ ...prev, version: metadata.version }));
          setTimeout(() => window.location.reload(), 2000);
        }
      }
    } catch (error) {
      console.error('업데이트 다운로드 오류:', error);
      alert(t('update_download_fail'));
    }
  }, [profile.status, localIp, t]);

  // 롤백
  const rollback = useCallback(async () => {
    if (!update) return;
    try {
      const response = await axios.get(
        `https://localhost:8000/rollback?version=${update.version}`,
        {
          responseType: 'arraybuffer',
          httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
        }
      );
      const blob = new Blob([response.data]);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup-${update.version}.zip`;
      a.click();
      window.URL.revokeObjectURL(url);
      alert(t('rollback_success'));
    } catch (error) {
      console.error('롤백 오류:', error);
      alert(t('rollback_fail'));
    }
  }, [update, t]);

  // 활동 로그 가져오기
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const response = await axios.get('https://localhost:8000/logs', {
          httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
        );
        setLogs(response.data);
      } catch (error) {
        console.error('로그 가져오기 오류:', error);
      }
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 10000);
    return () => clearInterval(interval);
  }, []);

  // 알림 권한 요청
  useEffect(() => {
    if (Notification.permission !== 'granted') {
      Notification.requestPermission();
    }
  }, []);

  // 키보드 단축키
  useHotkeys('ctrl+enter', sendMessage, [sendMessage]);
  useHotkeys('ctrl+u', () => document.querySelector('input[type="file"]')?.click());
  useHotkeys('ctrl+l', () => setShowLogs(prev => !prev));

  // 테마 전환
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  // 이모지 선택
  const onEmojiClick = (event: any) => {
    setChatInput(prev => prev + event.emoji);
    setShowEmojiPicker(false);
  };

  // 공유 폴더 생성
  const createSharedFolder = async () => {
    if (!sharedFolder || /[<>\|]/.test(sharedFolder)) {
      alert(t('invalid_folder_name'));
      return;
    }
    try {
      await axios.post(
        `https://localhost:8000/share-folder?folder=${sharedFolder}`,
        {},
        {
          headers: { Authorization: 'device-token' },
          httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
        }
      );
      alert(t('folder_created'));
      setSharedFolder('');
    } catch (error) {
      console.error('공유 폴더 생성 오류:', error);
      alert(t('folder_create_fail'));
    }
  };

  // 온라인 사용자 수
  const onlineCount = devices.filter(d => d.status === 'online').length;

  return (
    <div className={`discord-container ${theme}`}>
      <div className={`sidebar ${theme}`}>
        <h3>{t('device_list')}</h3>
        <ul>
          {devices.map(device => (
            <li
              key={device.name}
              onClick={() => setSelectedDevice(device)}
              className={selectedDevice?.name === device.name ? 'active' : ''}
              onMouseEnter={() => setShowProfileCard(device.ip)}
              onMouseLeave={() => setShowProfileCard(null)}
            >
              <span className={`user-status status-${device.status}`}></span>
              {device.name} ({device.ip}:{device.port}) - {t(device.status)} (v{device.version})
              <button onClick={() => toggleWhitelist(device.ip)}>
                {profile.autoAcceptWhitelist.includes(device.ip) ? t('remove_from_whitelist') : t('add_to_whitelist')}
              </button>
              {showProfileCard === device.ip && (
                <div className="profile-card" style={{ display: 'block', position: 'absolute', left: '260px' }}>
                  <div className="profile-avatar">{profiles[device.ip]?.nickname?.charAt(0) || '?'}</div>
                  <p>{t('nickname')}: {profiles[device.ip]?.nickname || device.name}</p>
                  <p>{t('status')}: {t(device.status)}</p>
                  <p>{t('version')}: {device.version}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="online-counter">{t('online_count', { count: onlineCount })}</div>
        <button className="theme-toggle" onClick={toggleTheme}>{theme === 'dark' ? t('light_mode') : t('dark_mode')}</button>
        <select onChange={e => i18n.changeLanguage(e.target.value)}>
          <option value="ko">{t('korean')}</option>
          <option value="en">{t('english')}</option>
        </select>
        <input
          type="text"
          value={profile.nickname}
          onChange={e => setProfile(prev => ({ ...prev, nickname: e.target.value }))}
          placeholder={t('nickname')}
        />
        <select onChange={e => toggleStatus(e.target.value as 'online' | 'offline' | 'idle' | 'dnd')}>
          <option value="online">{t('online')}</option>
          <option value="offline">{t('offline')}</option>
          <option value="idle">{t('idle')}</option>
          <option value="dnd">{t('dnd')}</option>
        </select>
        <button onClick={() => updateAutoAccept(!profile.autoAccept, profile.autoAcceptWhitelist)}>
          {profile.autoAccept ? t('disable_auto_accept') : t('enable_auto_accept')}
        </button>
      </div>
      <div className="main-content">
        <h1>NTP (Network To Peer)</h1>
        <p>{t('unique_id')}: {profile.uniqueId} (v{profile.version})</p>
        <div className={`connection-status ${connectionStatus}`}>{t(connectionStatus)}</div>
        {update && (
          <div className="update-notification">
            <h2>{t('update_available', { version: update.version, type: update.type })}</h2>
            <button onClick={() => downloadUpdate(update, true)}>{t('download_and_install')}</button>
            <button onClick={rollback}>{t('rollback')}</button>
          </div>
        )}
        <h2>{t('file_requests')}</h2>
        {fileRequests.map((request, index) => (
          <div key={index} className="file-request">
            <p>{t('file_request', { name: request.filename, sender: request.senderIp })}</p>
            <button onClick={() => handleFileRequest(request, true)}>{t('accept')}</button>
            <button onClick={() => handleFileRequest(request, false)}>{t('reject')}</button>
          </div>
        ))}
        <h2>{t('chat')}</h2>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('search_messages')}
          className={`search-bar ${theme}`}
        />
        <div ref={chatWindowRef} className={`chat-window ${theme}`}>
          {groupedMessages.map((group, index) => (
            <div key={index} className="chat-group">
              <h4>
                <span className={`user-status status-${profiles[group[0].sender]?.status || 'offline'}`}></span>
                {profiles[group[0].sender]?.nickname || group[0].sender}
              </h4>
              {group.map((msg, msgIndex) => (
                <div key={msgIndex} className={`chat-message ${theme}`}>
                  <div className="message-header">
                    <span className="username">{profiles[msg.sender]?.nickname || msg.sender}</span>
                    <span className="timestamp">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="message-content">
                    {msg.message.split(' ').map((word, i) => (
                      word.startsWith('@') && profiles[word.slice(1)] ? (
                        <span key={i} className="mention">{word}</span>
                      ) : (
                        <span key={i}>{word} </span>
                      )
                    ))}
                  </div>
                  <div className="message-reactions">
                    {msg.reactions.map((reaction, rIndex) => (
                      <span
                        key={rIndex}
                        className={`reaction ${reaction.users.includes(localIp) ? 'active' : ''}`}
                        onClick={() => addReaction(messages.indexOf(msg), reaction.emoji)}
                      >
                        {reaction.emoji} {reaction.count}
                      </span>
                    ))}
                    <button className="emoji-button" onClick={() => setShowEmojiPicker(true)}>😊</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {typingUsers.length > 0 && (
            <div className="typing-indicator">
              {typingUsers.map(ip => profiles[ip]?.nickname || ip).join(', ')} {t('typing')}
            </div>
          )}
        </div>
        <div className="chat-input">
          <button className="attach-button" onClick={() => document.querySelector('input[type="file"]')?.click()}>📎</button>
          <input
            type="text"
            value={chatInput}
            onChange={e => { setChatInput(e.target.value); handleTyping(); }}
            onKeyPress={e => e.key === 'Enter' && sendMessage()}
            placeholder={t('type_message')}
            className={theme}
          />
          <button className="emoji-button" onClick={() => setShowEmojiPicker(!showEmojiPicker)}>😊</button>
          <button onClick={sendMessage}>{t('send')}</button>
        </div>
        {showEmojiPicker && <Picker onEmojiClick={onEmojiClick} />}
        <h2>{t('file_sharing')}</h2>
        <div {...getRootProps()} className="dropzone">
          <input {...getInputProps()} webkitdirectory="true" />
          <p>{t('drop_files_or_folders')}</p>
        </div>
        <div className="upload-progress">
          {Object.entries(uploadProgress).map(([fileName, percent]) => (
            <div key={fileName}>
              <p>{fileName}: {percent}%</p>
              <button onClick={() => cancelUpload(fileName)}>{t('cancel')}</button>
            </div>
          ))}
          {Object.entries(downloadProgress).map(([fileName, percent]) => (
            <div key={fileName}>
              <p>{t('downloading')}: {fileName}: {percent}%</p>
            </div>
          ))}
        </div>
        <h2>{t('shared_folder')}</h2>
        <input
          type="text"
          value={sharedFolder}
          onChange={e => setSharedFolder(e.target.value)}
          placeholder={t('folder_name')}
        />
        <button onClick={createSharedFolder}>{t('create_folder')}</button>
        <button onClick={() => setShowLogs(prev => !prev)}>{t('toggle_logs')}</button>
        {showLogs && (
          <div className="log-panel">
            <h2>{t('activity_log')}</h2>
            <ul>
              {logs.map((log, index) => (
                <li key={index}>
                  [{log.timestamp}] {log.action}: {log.details}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;