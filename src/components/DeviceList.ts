import React from 'react';
import { useTranslation } from 'react-i18next';

interface Device {
  name: string;
  ip: string;
  port: number;
  status: 'online' | 'offline';
  version: string;
}

interface DeviceListTabProps {
  devices: Device[];
  selectedDevice: Device | null;
  setSelectedDevice: (device: Device | null) => void;
}

const DeviceListTab: React.FC<DeviceListTabProps> = ({ devices, selectedDevice, setSelectedDevice }) => {
  const { t } = useTranslation();

  return (
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
};

export default DeviceListTab;