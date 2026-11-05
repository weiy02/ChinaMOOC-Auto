# 教程视频

把文件命名为 `tutorial.mp4` 放进本目录（`docs/assets/video/tutorial.mp4`），教程页的视频位会自动变成播放器。
没有文件时显示占位框，不会报错。

## 建议参数

- 容器：MP4（H.264 + AAC），兼容性最好
- 分辨率：1280×720 或 1920×1080，16:9
- 时长：2~3 分钟，超过就剪成「安装」「自动学习」两段
- 体积：控制在 20MB 以内，GitHub Pages 单文件上限 100MB、仓库建议 1GB 以内
- 封面：另存一张 `../screenshots/00-video-poster.jpg`

## 想用 B 站视频

B 站播放器加载更快、也不占仓库体积。把 `docs/tutorial.html` 里的这一行：

```html
<div class="video-shell" data-video="./assets/video/tutorial.mp4" data-poster="..." data-title="...">
```

改成：

```html
<div class="video-shell" data-bvid="BV1xxxxxxxxx">
```

`data-bvid` 存在时会自动渲染 B 站 iframe，占位框自动移除。

## 压缩命令（macOS，需 ffmpeg）

```bash
ffmpeg -i raw.mov -vf "scale=1280:-2" -c:v libx264 -crf 26 -preset slow \
  -c:a aac -b:a 96k -movflags +faststart tutorial.mp4
```
