'use strict';

/**
 * electron-builder 构建配置。
 *
 * Windows 只出 zip 免安装包：解压即用，不写注册表、不建快捷方式、不做代码签名。
 * 签名相关的逻辑已全部移除——自签名证书消不掉 SmartScreen 提示，CA 证书要钱且
 * 2023 年后私钥必须放硬件（拿不到 pfx），对「发个压缩包给同事」这种分发方式没有收益。
 *
 * 为什么用 JS 配置文件而不是 package.json 的 "build" 字段：
 * electron-builder 一旦在 package.json 读到 "build" 字段就会完全忽略本文件
 * （app-builder-lib/out/util/config/load.js 的 loadConfig），配置只能留一份。
 *
 * 文件名必须是 electron-builder.js：查找列表只认
 * electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}，写成 electron-builder.config.js
 * 会被静默忽略，打包退回全默认配置。
 */

module.exports = {
  appId: 'com.forgelink.desktop',
  productName: 'ForgeLink',
  directories: {
    buildResources: 'build',
    output: 'release',
  },
  // 直接复用 node_modules 里已装好的 electron 运行时，
  // 否则打包会再下载一份完整分发包，国内网络很容易卡在超时。
  electronDist: 'node_modules/electron/dist',
  files: [
    'src/main/**/*',
    'dist-renderer/**/*',
    'package.json',
    'LICENSE',
    '!**/*.map',
  ],
  win: {
    // zip 就是 win-unpacked 的压缩包，解压后直接双击 ForgeLink.exe
    target: ['zip'],
    icon: 'build/icon.png',
    // 明确不签名；这一步关闭的是 signtool，rcedit 仍会写入图标与版本信息
    signExecutable: false,
  },
  mac: {
    target: ['zip'],
    category: 'public.app-category.utilities',
    icon: 'build/icon.png',
    // 没有 Apple 开发者证书时不要自动寻找签名身份，否则打包会直接报错
    identity: null,
  },
  linux: {
    target: ['zip'],
    category: 'Utility',
    maintainer: 'Evan, Zhen Wang <18901599114@163.com>',
    icon: 'build/icon.png',
  },
};
