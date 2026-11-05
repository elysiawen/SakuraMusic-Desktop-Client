// electron-vite 的 `?asset` 导入：构建时把文件复制到 out/main 下，并替换成运行时路径。
declare module '*?asset' {
  const src: string;
  export default src;
}
