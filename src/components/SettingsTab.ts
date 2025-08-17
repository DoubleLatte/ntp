import React from 'react';
import { useTranslation } from 'react-i18next';

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

interface SettingsTabProps {
  profile: Profile;
  setProfile: React.Dispatch<React.SetStateAction<Profile>>;
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
  networkId: string;
  setNetworkId: (id: string) => void;
  inviteCode: string;
  setInviteCode: (code: string) => void;
  generateInviteCode: () => void;
  joinWithInviteCode: (code: string) => void;
  saveSettings: () => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  profile,
  setProfile,
  theme,
  setTheme,
  networkId,
  setNetworkId,
  inviteCode,
  setInviteCode,
  generateInviteCode,
  joinWithInviteCode,
  saveSettings,
}) => {
  const { t, i18n } = useTranslation();

  return (
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
      <button onClick={() => joinWithInviteCode(inviteCode)}>{t('join_with_invite_code')}</button>
      <p>{t('npcap_info')}</p>
      <button onClick={saveSettings}>{t('save_settings')}</button>
    </div>
  );
};

export default SettingsTab;