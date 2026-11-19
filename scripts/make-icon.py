"""把 icon.svg 画成市场要的方形 PNG（市场只收 png/jpg/webp，不收 SVG）。"""
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
os.makedirs(OUT, exist_ok=True)

SIZE = 512
GOLD = (242, 180, 49)
GOLD_DARK = (185, 134, 29)
BROWN = (122, 79, 10)
WHITE = (255, 255, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 外圈金环
cx = cy = SIZE / 2
d.ellipse([22, 22, SIZE - 22, SIZE - 22], fill=GOLD, outline=GOLD_DARK, width=14)
# 内圈白环
d.ellipse([70, 70, SIZE - 70, SIZE - 70], outline=WHITE, width=10)

s = SIZE / 36.0

# 鲸鱼侧面剪影：圆润的头 + 尾巴分叉，在 96px 下也能认出来
def P(x, y):
    return (x * s, y * s)

# 身体（一条从嘴到尾根的弧线）
d.ellipse([P(8.0, 15.0), P(24.0, 27.0)], fill=BROWN)          # 主体圆
d.ellipse([P(6.4, 17.4), P(15.0, 24.6)], fill=BROWN)          # 头部前伸

# 尾鳍：两个三角形拼成分叉
d.polygon([P(22.2, 19.6), P(28.0, 14.6), P(26.4, 20.4)], fill=BROWN)
d.polygon([P(22.2, 19.6), P(28.4, 22.4), P(25.4, 25.6)], fill=BROWN)

# 腹部浅色
d.ellipse([P(9.0, 21.4), P(21.6, 27.4)], fill=(212, 160, 60))

# 眼睛
d.ellipse([P(10.6, 18.4), P(12.4, 20.2)], fill=WHITE)
d.ellipse([P(11.1, 18.9), P(12.0, 19.8)], fill=BROWN)

# 喷水（小水花，点明是鲸）
d.ellipse([P(14.0, 12.0), P(15.6, 13.6)], fill=(120, 190, 240))
d.ellipse([P(16.2, 10.8), P(17.8, 12.4)], fill=(150, 205, 245))
d.ellipse([P(12.0, 11.2), P(13.6, 12.8)], fill=(150, 205, 245))

img.save(os.path.join(OUT, "icon-512.png"), "PNG")
img.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "icon-180.png"), "PNG")
print("wrote", os.path.join(OUT, "icon-512.png"))
print("wrote", os.path.join(OUT, "icon-180.png"))
