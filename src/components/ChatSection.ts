import React from 'react';
import { useTranslation } from 'react-i18next';
import WebSocket from 'isomorphic-ws';
import { Buffer } from 'buffer';
import crypto from 'crypto';

interface ChatSectionProps {
  selectedGroup: string;
  setSelectedGroup: (group: string) => void;
  chatMessages: { message: string; senderIp: string; timestamp: string; isAudio?: boolean; audioUrl?: string }[];
  setChatMessages: React.Dispatch<React.SetStateAction<{ message: string; senderIp: string; timestamp: string; isAudio?: boolean; audioUrl?: string }[]>>;
  chatWs: WebSocket | null;
}

const ChatSection: React.FC<ChatSectionProps> = ({ selectedGroup, setSelectedGroup, chatMessages, setChatMessages, chatWs }) => {
  const { t } = useTranslation();

  const sendMessage = (message: string) => {
    if (chatWs?.readyState === WebSocket.OPEN) {
      const cipher = crypto.createCipher('aes-256-cbc', Buffer.from('secret-key-32-bytes-1234567890ab'));
      let encrypted = cipher.update(JSON.stringify({ type: 'chat', message }), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      chatWs.send(encrypted);
    }
  };

  return (
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
          if (e.key === 'Enter') {
            sendMessage(e.currentTarget.value);
            e.currentTarget.value = '';
          }
        }}
        placeholder={t('enter_message')}
        className="input"
      />
    </div>
  );
};

export default ChatSection;