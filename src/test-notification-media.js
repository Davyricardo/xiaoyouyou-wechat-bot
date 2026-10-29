'use strict';
const sharp=require('sharp');
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="720" height="220"><rect width="720" height="220" fill="#101825"/><text x="36" y="80" fill="#89e2d2" font-family="Noto Sans CJK SC" font-size="34">小鱿鱿图片提醒通道测试</text><text x="36" y="145" fill="white" font-family="Noto Sans CJK SC" font-size="25">这不是登录二维码，无需扫码。</text></svg>';
sharp(Buffer.from(svg)).png().toFile('/opt/xiaoyouyou/notification-channel-test.png').then(()=>console.log('Notification test image ready'));
