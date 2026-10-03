import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Cpu,
  ExternalLink,
  FileCheck2,
  FileCode2,
  FileUp,
  Fingerprint,
  Gauge,
  HardDrive,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Plug,
  Radio,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  Upload,
  Usb,
  X,
  Zap,
} from 'lucide-react';
import { ESPLoader, Transport } from 'esptool-js';
import SparkMD5 from 'spark-md5';
import './style.css';

const MAX_FIRMWARE_SIZE = 32 * 1024 * 1024;
const BAUD_RATES = [115200, 230400, 460800, 921600, 1500000];
const FLASH_SIZES = ['detect', 'keep', '2MB', '4MB', '8MB', '16MB', '32MB'];
const FLASH_MODES = ['dio', 'qio', 'dout', 'qout', 'keep'];
const FLASH_FREQS = ['40m', '80m', '26m', '20m', 'keep'];

const toHex = (value, width = 0) => `0x${value.toString(16).padStart(width, '0')}`;
const formatSize = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 2)} ${units[power]}`;
};
const shortHash = (hash) => (hash ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : '待固件载入后生成');

function readImageHeader(data) {
  if (data.byteLength < 24) throw new Error('文件太小，不是有效的 ESP 镜像。');
  if (data[0] !== 0xe9) throw new Error('镜像头校验失败：ESP 固件应以 0xE9 开头。');
  const segments = data[1];
  if (segments < 1 || segments > 16) throw new Error('镜像段数无效，请选择 ESP32-S3 的 .bin 固件。');
  const chipId = data[12] | (data[13] << 8);
  if (chipId !== 9) {
    throw new Error(`目标芯片不匹配：镜像标识为 ${chipId}，预期 ESP32-S3（9）。`);
  }
  return { segments, chipId };
}

async function sha256(data) {
  const digest = await crypto.subtle.digest('SHA-256', data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function App() {
  const [firmware, setFirmware] = useState(null);
  const [sourceMode, setSourceMode] = useState('file');
  const [firmwareUrl, setFirmwareUrl] = useState('');
  const [expectedHash, setExpectedHash] = useState('');
  const [port, setPort] = useState(null);
  const [portInfo, setPortInfo] = useState(null);
  const [baudrate, setBaudrate] = useState(460800);
  const [flashSize, setFlashSize] = useState('detect');
  const [flashMode, setFlashMode] = useState('dio');
  const [flashFreq, setFlashFreq] = useState('40m');
  const [flashAddress, setFlashAddress] = useState('0x0');
  const [eraseAll, setEraseAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingFirmware, setLoadingFirmware] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('idle');
  const [chip, setChip] = useState('');
  const [flashVerified, setFlashVerified] = useState(false);
  const [message, setMessage] = useState('');
  const [logs, setLogs] = useState([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  const logRef = useRef(null);
  const sourceName = firmware?.name || '';
  const serialSupported = typeof navigator !== 'undefined' && 'serial' in navigator;
  const secureOrigin = typeof window !== 'undefined' && window.isSecureContext;

  const expectedHashNormalized = expectedHash.trim().toLowerCase().replace(/^sha256[:=\s]*/i, '').replace(/\s/g, '');
  const expectedHashValid = !expectedHashNormalized || /^[a-f\d]{64}$/.test(expectedHashNormalized);
  const expectedHashMatches = !expectedHashNormalized || expectedHashNormalized === firmware?.sha256;
  const firmwareReady = Boolean(firmware?.valid && expectedHashValid && expectedHashMatches);
  const canFlash = Boolean(firmwareReady && port && !busy && !loadingFirmware && secureOrigin && serialSupported);
  const selectedPortLabel = portInfo
    ? `USB ${toHex(portInfo.usbVendorId || 0, 4)} · ${toHex(portInfo.usbProductId || 0, 4)}`
    : port
      ? '串口已选择'
      : '尚未选择端口';

  const addLog = useCallback((text, tone = 'normal') => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs((current) => [...current.slice(-179), { time, text: String(text), tone }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const clearFlashState = () => {
    setPhase('idle');
    setProgress(0);
    setFlashVerified(false);
    setMessage('');
  };

  const loadFirmwareData = async (data, name, origin) => {
    if (!data.byteLength) throw new Error('固件文件为空。');
    if (data.byteLength > MAX_FIRMWARE_SIZE) throw new Error('固件超过 32 MB，请确认文件后再载入。');
    const header = readImageHeader(data);
    const digest = await sha256(data);
    const next = {
      data,
      name,
      origin,
      size: data.byteLength,
      sha256: digest,
      header,
      valid: true,
    };
    setFirmware(next);
    clearFlashState();
    addLog(`已载入 ${name}（${formatSize(data.byteLength)}），ESP32-S3 镜像头有效。`, 'success');
    return next;
  };

  const handleLocalFile = async (file) => {
    if (!file) return;
    setLoadingFirmware(true);
    setMessage('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await loadFirmwareData(bytes, file.name, 'local');
    } catch (error) {
      setFirmware(null);
      setMessage(error.message || '读取固件失败。');
      addLog(error.message || '读取固件失败。', 'error');
    } finally {
      setLoadingFirmware(false);
    }
  };

  const handleUrlLoad = async () => {
    let parsed;
    try {
      parsed = new URL(firmwareUrl.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 固件链接。');
    } catch (error) {
      setMessage(error.message || '请输入有效的固件链接。');
      return;
    }
    setLoadingFirmware(true);
    setMessage('');
    try {
      const response = await fetch(parsed.href, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error(`固件下载失败：HTTP ${response.status}。`);
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_FIRMWARE_SIZE) throw new Error('固件超过 32 MB，请确认链接指向正确的文件。');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'firmware.bin');
      await loadFirmwareData(bytes, name, 'url');
    } catch (error) {
      setFirmware(null);
      const corsHint = error instanceof TypeError ? '无法读取链接。请确认文件服务器允许跨域访问（CORS），或改用本地文件。' : error.message;
      setMessage(corsHint || '下载固件失败。');
      addLog(corsHint || '下载固件失败。', 'error');
    } finally {
      setLoadingFirmware(false);
    }
  };

  const choosePort = async () => {
    if (!serialSupported || !secureOrigin) {
      setMessage('串口烧写需要支持 Web Serial 的 Chrome / Edge，并通过 HTTPS 或 localhost 打开。');
      return;
    }
    try {
      const selected = await navigator.serial.requestPort();
      setPort(selected);
      setPortInfo(selected.getInfo?.() || null);
      setChip('');
      clearFlashState();
      addLog('已选择串口设备。', 'success');
    } catch (error) {
      if (error.name !== 'NotFoundError') {
        setMessage(error.message || '无法选择串口设备。');
        addLog(error.message || '无法选择串口设备。', 'error');
      }
    }
  };

  const createLoader = (activePort, activeTransport) => {
    const terminal = {
      clean: () => {},
      writeLine: (data) => addLog(data),
      write: (data) => addLog(data),
    };
    return new ESPLoader({
      transport: activeTransport,
      baudrate: Number(baudrate),
      port: activePort,
      debugLogging: false,
      terminal,
    });
  };

  const verifyConnectedChip = (chipName) => {
    const detectedName = String(chipName || '');
    setChip(detectedName);
    if (!detectedName.toLowerCase().includes('esp32-s3')) {
      throw new Error(`检测到 ${detectedName || '未知芯片'}，此工具仅允许烧写 ESP32-S3。`);
    }
    addLog(`设备验证通过：${detectedName}。`, 'success');
  };

  const detectDevice = async () => {
    if (!port || busy) return;
    setBusy(true);
    setPhase('connecting');
    setProgress(0);
    setMessage('');
    setChip('');
    addLog('正在连接设备并检查芯片型号…');
    const transport = new Transport(port, true);
    try {
      const loader = createLoader(port, transport);
      const chipName = await loader.main();
      verifyConnectedChip(chipName);
      setPhase('ready');
      try {
        await loader.after('hard_reset');
        addLog('连接检测完成，设备已重启。', 'success');
      } catch (resetError) {
        addLog(`设备已通过芯片检测，但自动重启失败：${resetError.message || '请手动复位设备。'}`, 'warning');
      }
    } catch (error) {
      setPhase('error');
      setMessage(error.message || '设备检测失败，请检查端口和 BOOT 模式。');
      addLog(error.message || '设备检测失败。', 'error');
    } finally {
      try { await transport.disconnect(); } catch {}
      setBusy(false);
    }
  };

  const startFlash = async () => {
    if (!canFlash) return;
    const addressText = flashAddress.trim();
    const address = Number(addressText);
    if (!/^0x[\da-f]+$/i.test(addressText) && !/^\d+$/.test(addressText)) {
      setMessage('烧写地址格式错误，请输入十六进制地址（例如 0x0）。');
      return;
    }
    if (!Number.isSafeInteger(address) || address < 0 || address % 0x1000 !== 0) {
      setMessage('烧写地址必须是 4 KB 对齐的非负地址。');
      return;
    }
    setBusy(true);
    setProgress(0);
    setPhase('connecting');
    setFlashVerified(false);
    setMessage('');
    addLog(`开始烧写 ${sourceName}，地址 ${toHex(address)}。`);

    const transport = new Transport(port, true);
    try {
      const loader = createLoader(port, transport);
      const chipName = await loader.main();
      verifyConnectedChip(chipName);
      setPhase('flashing');
      addLog(`串口已连接，波特率 ${Number(baudrate).toLocaleString()}。`);
      await loader.writeFlash({
        fileArray: [{ data: firmware.data, address }],
        flashMode,
        flashFreq,
        flashSize,
        eraseAll,
        compress: true,
        calculateMD5Hash: (image) => SparkMD5.ArrayBuffer.hash(
          image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
        ),
        reportProgress: (_fileIndex, written, total) => {
          setProgress(total ? Math.min(100, Math.round((written / total) * 100)) : 0);
        },
      });
      setProgress(100);
      setFlashVerified(true);
      setPhase('success');
      setMessage('写入完成，闪存回读 MD5 校验通过。');
      addLog('烧写完成，闪存数据校验通过。', 'success');
      try {
        await loader.after('hard_reset');
        addLog('设备已重启。', 'success');
      } catch (resetError) {
        addLog(`固件已烧写并通过校验，但自动重启失败：${resetError.message || '请手动复位设备。'}`, 'warning');
      }
    } catch (error) {
      setPhase('error');
      setMessage(error.message || '烧写失败，请检查设备连接及固件参数。');
      addLog(error.message || '烧写失败。', 'error');
    } finally {
      try { await transport.disconnect(); } catch {}
      setBusy(false);
    }
  };

  const shaValidationText = useMemo(() => {
    if (!expectedHashNormalized) return '输入发布方提供的 SHA-256，可确认固件来源未被篡改。';
    if (!expectedHashValid) return 'SHA-256 应为 64 位十六进制字符。';
    if (!firmware?.sha256) return '载入固件后将自动比对摘要。';
    return expectedHashMatches ? 'SHA-256 一致，固件摘要校验通过。' : 'SHA-256 不一致，请重新下载并核对固件。';
  }, [expectedHashNormalized, expectedHashValid, expectedHashMatches, firmware?.sha256]);

  const resetFirmware = () => {
    setFirmware(null);
    setExpectedHash('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    clearFlashState();
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files?.[0]) handleLocalFile(event.dataTransfer.files[0]);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="焊点首页">
          <span className="brand-mark"><Zap size={18} fill="currentColor" /></span>
          <span className="brand-name">焊点<span className="brand-divider">/</span><span className="brand-product">FLASH STUDIO</span></span>
        </a>
        <nav className="topnav" aria-label="主导航">
          <a className="active" href="#flasher">固件烧录</a>
        </nav>
        <div className="topbar-right">
          <span className={`browser-pill ${serialSupported && secureOrigin ? 'supported' : 'unsupported'}`}>
            <span className="status-dot" />
            {serialSupported && secureOrigin ? '浏览器已就绪' : '需要 Chrome / Edge'}
          </span>
          <span className="version-label">ESP32-S3 <span>·</span> WEB TOOL</span>
        </div>
      </header>

      <main id="top" className="main-content">
        <section className="intro" id="flasher">
          <div className="intro-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> ESPRESSIF · ESP32-S3</div>
            <h1>固件，<span>一刷即达。</span></h1>
            <p>在浏览器里完成固件验证、设备连接与烧录。固件只在本地处理，通过 USB 串口直连你的开发板。</p>
          </div>
          <div className="intro-side">
            <div className="privacy-stamp"><LockKeyhole size={15} /><span>本地处理 · 不上传固件</span></div>
            <div className="intro-side-note">SECURE WORKFLOW <ArrowDownToLine size={14} /></div>
          </div>
        </section>

        <div className="workspace-grid">
          <div className="workspace-main">
            <section className="panel firmware-panel" aria-labelledby="firmware-title">
              <div className="panel-heading">
                <div className="section-index">01</div>
                <div>
                  <h2 id="firmware-title">选择固件</h2>
                  <p>支持 ESP32-S3 固件镜像（.bin）</p>
                </div>
                <div className="heading-tag"><FileCode2 size={14} /> FIRMWARE</div>
              </div>

              <div className="source-switch" role="tablist" aria-label="固件来源">
                <button className={sourceMode === 'file' ? 'source-tab selected' : 'source-tab'} onClick={() => setSourceMode('file')} role="tab" aria-selected={sourceMode === 'file'}>
                  <Upload size={15} /> 本地文件
                </button>
                <button className={sourceMode === 'url' ? 'source-tab selected' : 'source-tab'} onClick={() => setSourceMode('url')} role="tab" aria-selected={sourceMode === 'url'}>
                  <Link2 size={15} /> 固件链接
                </button>
              </div>

              {sourceMode === 'file' ? (
                <div
                  className={`dropzone ${dragging ? 'dragging' : ''} ${firmware ? 'has-file' : ''}`}
                  onClick={() => !loadingFirmware && fileInputRef.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click(); }}
                >
                  <input ref={fileInputRef} type="file" accept=".bin,application/octet-stream" hidden onChange={(event) => handleLocalFile(event.target.files?.[0])} />
                  {loadingFirmware ? <span className="drop-icon spinning"><LoaderCircle size={21} /></span> : <span className="drop-icon"><FileUp size={21} /></span>}
                  <div className="drop-copy">
                    <strong>{firmware ? '固件已就绪' : loadingFirmware ? '正在读取并验证…' : '拖入固件文件，或点击浏览'}</strong>
                    <span>{firmware ? `${firmware.name} · ${formatSize(firmware.size)}` : 'BIN 格式 · 最大 32 MB'}</span>
                  </div>
                  {firmware ? (
                    <button className="icon-button remove-file" aria-label="移除固件" onClick={(event) => { event.stopPropagation(); resetFirmware(); }}><X size={16} /></button>
                  ) : <span className="browse-label">选择文件 <ArrowRight size={14} /></span>}
                </div>
              ) : (
                <div className="url-loader">
                  <label className="field-label" htmlFor="firmware-url">固件直链</label>
                  <div className="url-input-wrap"><Link2 size={16} /><input id="firmware-url" type="url" placeholder="https://example.com/firmware.bin" value={firmwareUrl} onChange={(event) => setFirmwareUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') handleUrlLoad(); }} /><button className="button button-dark" disabled={!firmwareUrl || loadingFirmware} onClick={handleUrlLoad}>{loadingFirmware ? <LoaderCircle size={15} className="spin" /> : '获取固件'}</button></div>
                  <div className="inline-note"><CircleHelp size={13} />链接服务器需要允许跨域访问（CORS）；失败时可下载后选择本地文件。</div>
                </div>
              )}

              {message && phase !== 'success' && <div className="inline-error"><X size={14} />{message}</div>}

              <div className="integrity-card">
                <div className="integrity-title-row">
                  <div className="integrity-title"><ShieldCheck size={16} /><span>镜像完整性</span></div>
                  <span className={`check-label ${firmwareReady ? 'ok' : firmware ? 'warning' : ''}`}>
                    {firmwareReady ? <><CheckCircle2 size={13} /> 已验证</> : firmware ? <><Activity size={13} /> 待确认</> : '等待固件'}
                  </span>
                </div>
                <div className="hash-row">
                  <div className="hash-info"><span className="meta-label">SHA-256 摘要</span><code title={firmware?.sha256 || ''}>{shortHash(firmware?.sha256)}</code></div>
                  <div className="header-chip"><Cpu size={14} />{firmware?.header ? `ESP32-S3 · ${firmware.header.segments} 段` : '镜像头待检测'}</div>
                </div>
                <label className="field-label expected-label" htmlFor="expected-hash">发布方 SHA-256 <span>可选</span></label>
                <input id="expected-hash" className={`text-input hash-input ${expectedHashNormalized && (!expectedHashValid || !expectedHashMatches) ? 'invalid' : ''}`} value={expectedHash} onChange={(event) => setExpectedHash(event.target.value)} placeholder="粘贴 64 位摘要以验证固件来源" spellCheck="false" autoComplete="off" />
                <div className={`validation-hint ${expectedHashNormalized && expectedHashValid && !expectedHashMatches ? 'error' : expectedHashMatches && expectedHashNormalized ? 'success' : ''}`}>
                  {expectedHashMatches && expectedHashNormalized && expectedHashValid ? <Check size={12} /> : <CircleHelp size={12} />}{shaValidationText}
                </div>
              </div>
            </section>

            <section className="panel config-panel" aria-labelledby="config-title">
              <div className="panel-heading compact-heading">
                <div className="section-index">02</div>
                <div>
                  <h2 id="config-title">设备与参数</h2>
                  <p>连接开发板并配置烧录选项</p>
                </div>
                <div className="heading-tag"><Usb size={14} /> SERIAL</div>
              </div>

              <div className="port-select-row">
                <div className={`port-icon ${port ? 'connected' : ''}`}><Radio size={18} /></div>
                <div className="port-details"><span className="field-label">串口设备</span><strong>{selectedPortLabel}</strong><small>{port ? '授权已保存 · 点击重新选择' : '使用 USB 数据线连接开发板'}</small></div>
                <button className="button button-outline" onClick={choosePort} disabled={busy}><Plug size={15} />{port ? '更换端口' : '选择端口'}</button>
              </div>

              <div className="settings-grid">
                <label className="setting-field"><span><Gauge size={14} />烧录波特率</span><div className="select-wrap"><select value={baudrate} onChange={(event) => setBaudrate(Number(event.target.value))}>{BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate.toLocaleString()} bps</option>)}</select><ChevronDown size={14} /></div></label>
                <label className="setting-field"><span><HardDrive size={14} />闪存容量</span><div className="select-wrap"><select value={flashSize} onChange={(event) => setFlashSize(event.target.value)}>{FLASH_SIZES.map((size) => <option key={size} value={size}>{size === 'detect' ? '自动检测' : size === 'keep' ? '保持原值' : size}</option>)}</select><ChevronDown size={14} /></div></label>
                <label className="setting-field"><span><Activity size={14} />闪存模式</span><div className="select-wrap"><select value={flashMode} onChange={(event) => setFlashMode(event.target.value)}>{FLASH_MODES.map((mode) => <option key={mode} value={mode}>{mode.toUpperCase()}{mode === 'dio' ? ' · 推荐' : ''}</option>)}</select><ChevronDown size={14} /></div></label>
                <label className="setting-field"><span><Gauge size={14} />闪存频率</span><div className="select-wrap"><select value={flashFreq} onChange={(event) => setFlashFreq(event.target.value)}>{FLASH_FREQS.map((freq) => <option key={freq} value={freq}>{freq === 'keep' ? '保持原值' : freq.toUpperCase()}</option>)}</select><ChevronDown size={14} /></div></label>
                <label className="setting-field address-field"><span><ArrowDownToLine size={14} />烧写地址 <small>4 KB 对齐</small></span><input className="text-input address-input" value={flashAddress} onChange={(event) => setFlashAddress(event.target.value)} spellCheck="false" /></label>
                <label className={`erase-toggle ${eraseAll ? 'enabled' : ''}`}>
                  <input type="checkbox" checked={eraseAll} onChange={(event) => setEraseAll(event.target.checked)} />
                  <span className="toggle-switch" />
                  <span><strong>烧写前擦除全部闪存</strong><small>会清空设备上的所有数据</small></span>
                </label>
              </div>

              <div className="device-actions">
                <button className="button button-link" onClick={detectDevice} disabled={!port || busy}><RefreshCw size={14} className={busy && phase === 'connecting' ? 'spin' : ''} />{busy && phase === 'connecting' ? '正在连接…' : '检测设备'}</button>
                <span className={`device-check ${chip.toLowerCase().includes('esp32-s3') ? 'passed' : ''}`}>{chip.toLowerCase().includes('esp32-s3') ? <><CheckCircle2 size={13} />{chip} 验证通过</> : <><CircleHelp size={13} />烧写时自动验证芯片型号</>}</span>
              </div>
            </section>

            <section className={`flash-action ${phase === 'success' ? 'flash-success' : phase === 'error' ? 'flash-error' : ''}`}>
              <div className="flash-action-copy">
                <span className="action-step"><span className="pulse-dot" />03 / PROGRAM</span>
                <strong>{phase === 'success' ? '烧写完成' : phase === 'error' ? '烧写未完成' : busy ? '设备正在工作…' : '一切就绪，开始烧录'}</strong>
                <span>{phase === 'success' ? '固件已写入并通过回读验证' : phase === 'error' ? message : '请保持设备连接，烧录期间不要拔出 USB'}</span>
              </div>
              <div className="flash-action-buttons">
                {phase === 'success' && flashVerified ? <span className="verified-result"><CheckCircle2 size={17} />MD5 已校验</span> : null}
                <button className="flash-button" onClick={startFlash} disabled={!canFlash}>
                  {busy ? <LoaderCircle size={18} className="spin" /> : phase === 'success' ? <CheckCircle2 size={18} /> : <Zap size={18} fill="currentColor" />}
                  {busy ? '正在烧写' : phase === 'success' ? '再次烧写' : '开始烧写'}
                  {!busy && phase !== 'success' && <ArrowRight size={16} />}
                </button>
              </div>
              {busy && <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>}
              {!firmwareReady && !busy && <div className="action-gate"><CircleHelp size={13} />请先载入有效的 ESP32-S3 固件</div>}
              {firmwareReady && !port && !busy && <div className="action-gate"><CircleHelp size={13} />请先选择串口设备</div>}
              {phase === 'success' && <div className="success-feedback">{message}</div>}
            </section>
          </div>

          <aside className="workspace-aside">
            <section className="panel run-panel" aria-labelledby="run-title">
              <div className="aside-heading"><div><span className="eyebrow">LIVE SESSION</span><h2 id="run-title">烧录状态</h2></div><span className={`session-badge ${busy ? 'active' : phase === 'success' ? 'done' : ''}`}><span className="status-dot" />{busy ? '进行中' : phase === 'success' ? '已完成' : phase === 'error' ? '异常' : '待机'}</span></div>
              <div className="session-device"><span className="device-chip-graphic"><Cpu size={24} /></span><div><strong>{chip || 'ESP32-S3'}</strong><span>{port ? selectedPortLabel : '等待设备连接'}</span></div></div>
              <div className="progress-label-row"><span>{phase === 'flashing' ? '正在写入固件' : phase === 'success' ? '写入与校验' : phase === 'connecting' ? '连接与芯片检测' : '任务进度'}</span><strong>{busy ? `${progress}%` : phase === 'success' ? '100%' : '—'}</strong></div>
              <div className="progress-track aside-track"><span style={{ width: `${busy ? progress : phase === 'success' ? 100 : 0}%` }} /></div>
              <div className="session-stats">
                <div><span>固件大小</span><strong>{firmware ? formatSize(firmware.size) : '—'}</strong></div>
                <div><span>烧写地址</span><strong>{flashAddress || '—'}</strong></div>
              </div>
              <div className="session-verification">
                <div className={firmwareReady ? 'verified' : ''}><span className="verification-icon"><FileCheck2 size={14} /></span><span>镜像头与目标芯片</span>{firmwareReady ? <Check size={14} /> : <span className="pending-mark">—</span>}</div>
                <div className={phase === 'success' && flashVerified ? 'verified' : ''}><span className="verification-icon"><Fingerprint size={14} /></span><span>闪存回读 MD5</span>{phase === 'success' && flashVerified ? <Check size={14} /> : <span className="pending-mark">—</span>}</div>
              </div>
            </section>

            <section className="panel console-panel" aria-labelledby="console-title">
              <div className="console-head"><div className="console-title"><TerminalSquare size={15} /><h2 id="console-title">运行日志</h2><span className="live-indicator"><span />LIVE</span></div><button className="console-clear" onClick={() => setLogs([])} disabled={!logs.length}>清空</button></div>
              <div className="console-body" ref={logRef} role="log" aria-live="polite">
                {logs.length ? logs.map((entry, index) => <div className={`log-line ${entry.tone}`} key={`${entry.time}-${index}`}><span className="log-time">{entry.time}</span><span className="log-prompt">›</span><span>{entry.text}</span></div>) : <div className="console-empty"><span className="console-cursor">_</span><span>等待操作…</span></div>}
              </div>
              <div className="console-foot"><span><span className="console-led" />串口监视器已就绪</span><span>{logs.length.toString().padStart(2, '0')} 条记录</span></div>
            </section>

            <section className="tip-card" id="guide">
              <div className="tip-icon"><CircleHelp size={17} /></div>
              <div><strong>第一次连接？</strong><p>若设备未自动进入下载模式，请按住 BOOT，再轻按 RESET 后松开。</p><a href="https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/boot-mode-selection.html" target="_blank" rel="noreferrer">查看连接指南 <ExternalLink size={12} /></a></div>
            </section>
          </aside>
        </div>

        <footer className="page-footer">
          <span>焊点 <i>·</i> 面向开发者的轻量烧录工具</span>
          <span><LockKeyhole size={12} />固件仅在你的浏览器与设备间传输</span>
          <a href="https://github.com/espressif/esptool-js" target="_blank" rel="noreferrer">POWERED BY ESPTOOL-JS <ExternalLink size={11} /></a>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
