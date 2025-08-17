import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import crypto from 'crypto';
import { program } from 'commander';

// 명령줄 옵션 설정
program
  .option('--version <version>', '업데이트 버전 (예: 1.1.0)')
  .option('--type <type>', '업데이트 유형 (main 또는 custom)', 'main')
  .option('--source <path>', '소스 디렉토리 경로', './app')
  .option('--output <path>', '출력 디렉토리 경로', './updates')
  .option('--private-key <path>', '개인 키 파일 경로', './private-key.pem');
program.parse(process.argv);

const options = program.opts<{
  version: string;
  type: 'main' | 'custom';
  source: string;
  output: string;
  privateKey: string;
}>();

// 입력 검증
if (!options.version || !semver.valid(options.version)) {
  console.error('유효한 버전을 지정해야 합니다. 예: --version 1.1.0');
  process.exit(1);
}
if (!['main', 'custom'].includes(options.type)) {
  console.error('업데이트 유형은 main 또는 custom이어야 합니다.');
  process.exit(1);
}
if (!fs.existsSync(options.source)) {
  console.error(`소스 디렉토리 ${options.source}가 존재하지 않습니다.`);
  process.exit(1);
}
if (!fs.existsSync(options.privateKey)) {
  console.error(`개인 키 파일 ${options.privateKey}가 존재하지 않습니다.`);
  process.exit(1);
}

// 디렉토리 준비
const outputDir = path.resolve(options.output);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// 업데이트 파일 생성
const zip = new AdmZip();
const sourceDir = path.resolve(options.source);
zip.addLocalFolder(sourceDir, '');
const zipFileName = `ntp-update-${options.version}.zip`;
const zipFilePath = path.join(outputDir, zipFileName);
zip.writeZip(zipFilePath);
console.log(`업데이트 파일 생성: ${zipFilePath}`);

// 서명 생성
const privateKey = fs.readFileSync(options.privateKey, 'utf8');
const fileContent = fs.readFileSync(zipFilePath);
const signer = crypto.createSign('SHA256');
signer.update(fileContent);
const signature = signer.sign(privateKey, 'hex');

// 메타데이터 생성
const metadata = {
  version: options.version,
  type: options.type,
  file: zipFileName,
  signature
};
const metadataPath = path.join(outputDir, 'update-metadata.json');
fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
console.log(`메타데이터 생성: ${metadataPath}`);