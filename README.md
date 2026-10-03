# 焊点 · ESP32-S3 固件烧录器

基于 React、Vite 和 Espressif 官方 `esptool-js` 的浏览器烧录工具。固件在浏览器本地载入，使用 Web Serial API 直接写入 ESP32-S3。

## 启动

```bash
npm install
npm run dev
```

使用支持 Web Serial 的 Chrome 或 Edge，在 `http://localhost:5173` 打开。线上部署时必须使用 HTTPS。Safari 和 Firefox 当前不支持本工具所需的 Web Serial API。

## 使用

1. 载入 ESP32-S3 `.bin` 固件，或填写支持跨域读取的 HTTP(S) 固件直链。
2. 可选地填写固件发布方公布的 SHA-256 摘要；页面会在烧写前比对。
3. 选择 USB 串口、配置波特率、闪存容量、模式、频率和写入地址。
4. 点击“检测设备”或“开始烧写”。工具会检查连接芯片型号，并在写入后通过设备端 MD5 回读校验。

默认写入地址为 `0x0`，适用于合并后的完整固件。若固件只有应用程序镜像，请按固件构建说明设置地址（常见为 `0x10000`）。串口访问由浏览器的设备选择对话框授权；设备在浏览器和 ESP32-S3 之间直连，固件不会上传到服务器。

固件链接需要服务器通过 CORS 允许当前网站读取。若浏览器因 CORS 拒绝访问，请先将文件下载到本地再载入。

## 构建

```bash
npm run build
npm run preview
```

