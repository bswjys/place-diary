"""오늘의 발자국 앱 아이콘 생성기.

토스 블루 그라데이션(#3182F6 → #1B64DA) 위에 흰색 지도 핀을 크게 그렸다.
아이폰 홈 화면 60pt에서도 바로 "장소"로 읽히도록 여백과 두께를 잡았고,
icon-512-maskable.png 는 안드로이드가 원형으로 잘라도 핀이 잘리지 않도록
같은 그림을 78% 크기로 줄여 놓은 판이다.

    python3 make_icons.py
"""
import os

from PIL import Image, ImageDraw

W = 1024
C1 = (49, 130, 246)    # #3182F6
C2 = (27, 100, 218)    # #1B64DA
WHITE = (255, 255, 255)
MASKABLE_SCALE = 0.78

HERE = os.path.dirname(os.path.abspath(__file__))


def gradient(size):
    small = 128
    g = Image.new('RGB', (small, small))
    px = g.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2 * (small - 1))
            px[x, y] = tuple(round(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return g.resize((size, size), Image.BICUBIC)


def pin_layer(scale=1.0):
    """투명 레이어에 흰색 지도 핀을 (가운데 기준) scale 배로 그린다."""
    layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    cx, cy = 512, 430
    r = 212
    # 핀 머리 (원) + 아래로 모이는 꼬리
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE + (250,))
    d.polygon([(cx - 206, cy + 50), (cx + 206, cy + 50), (cx, 828)], fill=WHITE + (250,))

    if scale != 1.0:
        box = layer.getbbox()
        cropped = layer.crop(box)
        nw = max(1, round(cropped.width * scale))
        nh = max(1, round(cropped.height * scale))
        cropped = cropped.resize((nw, nh), Image.LANCZOS)
        out = Image.new('RGBA', (W, W), (0, 0, 0, 0))
        out.paste(cropped, ((W - nw) // 2, (W - nh) // 2), cropped)
        layer = out

    return layer


def compose(scale=1.0):
    base = gradient(W).convert('RGBA')
    pin = pin_layer(scale)
    # 핀 가운데 구멍: 핀 위에 배경색을 다시 찍어 뚫린 것처럼 보이게 한다
    hr = max(1, round(86 * scale))
    hx = 512
    hy = round((W / 2) + (430 - W / 2) * scale)
    bg = gradient(W).crop((hx - hr, hy - hr, hx + hr, hy + hr)).convert('RGBA')
    mask = Image.new('L', (hr * 2, hr * 2), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, hr * 2 - 1, hr * 2 - 1], fill=255)
    pin.paste(bg, (hx - hr, hy - hr), mask)
    return Image.alpha_composite(base, pin).convert('RGB')


def rounded(img, radius_ratio=0.0):
    if radius_ratio <= 0:
        return img
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, img.size[0] - 1, img.size[1] - 1], radius=round(img.size[0] * radius_ratio), fill=255
    )
    out = Image.new('RGB', img.size, (255, 255, 255))
    out.paste(img, (0, 0), mask)
    return out


def main():
    big = compose(1.0)
    big.save(os.path.join(HERE, 'icon-512.png'))
    big.resize((192, 192), Image.LANCZOS).save(os.path.join(HERE, 'icon-192.png'))
    big.resize((180, 180), Image.LANCZOS).save(os.path.join(HERE, 'apple-touch-icon.png'))
    big.resize((180, 180), Image.LANCZOS).save(os.path.join(HERE, 'icon-180.png'))
    compose(MASKABLE_SCALE).save(os.path.join(HERE, 'icon-512-maskable.png'))
    print('icons written')


if __name__ == '__main__':
    main()
