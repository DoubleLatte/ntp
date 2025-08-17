import React from 'react';
import { useTranslation } from 'react-i18next';

interface FileDropProps {
  selectFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  uploadProgress: { [key: string]: number };
}

const FileDrop: React.FC<FileDropProps> = ({ selectFile, uploadProgress }) => {
  const { t } = useTranslation();

  return (
    <div className="tab-content">
      <h2>{t('file_drop')}</h2>
      <input type="file" onChange={selectFile} />
      {Object.entries(uploadProgress).map(([name, progress]) => (
        <div key={name}>{name}: {progress}%</div>
      ))}
    </div>
  );
};

export default FileDrop;