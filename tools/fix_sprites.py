#!/usr/bin/env python3
"""
스프라이트 시트 알파/가장자리 복구 도구.

원본 아트웍(RGB)은 손상되지 않았고 알파 채널과 경계 색만 잘못되어 있어서,
RGB 픽셀은 일절 새로 그리지 않고 아래 두 가지만 보정한다.

────────────────────────────────────────────────────────────────────
결함 1. 어두운 영역이 투명해짐  (좀비 전반, 여도사, 검객)
────────────────────────────────────────────────────────────────────
배경 제거 도구가 '어두운 픽셀 = 배경'으로 판정해, 검은 도포·머리카락·갓의
알파를 깎아냈다. 게임의 어두운 배경 위에서 캐릭터에 구멍이 뚫린 것처럼 보인다.
(근거: 약알파 영역의 RGB 평균이 10~13으로, 배경(≈0)과 뚜렷이 구분되는
 실제 그림 정보가 남아 있다. 즉 그림은 있는데 알파만 없다.)

  → core(확실한 전경)와 연결된, 검지 않은(=그려진) 영역을 실루엣으로 복원하고
    그 안의 '어두운' 픽셀만 불투명하게 되돌린다.

  DARK_T(휘도)와 SAT_T(채도) 두 조건이 핵심이다. 검객의 참격 호(청색),
  여도사의 부적 화염(보라) 같은 VFX는 원래 반투명해야 하는 요소라,
  함께 불투명화하면 각진 덩어리나 탁한 얼룩이 되어 오히려 품질이 나빠진다.
  손상은 '어둡고 무채색인' 옷·머리카락에서만 일어났으므로 거기만 고친다.
  (측정: 좀비의 복구 대상 픽셀은 채도 중앙값 2~7, 검객은 VFX가 겹쳐 18.9%가 채도 30 초과)

  구멍 메우기(fill_holes)는 쓰지 않는다. 활과 시위 사이처럼 실제로 비어 있어야
  하는 닫힌 영역까지 검게 채워버리기 때문.

────────────────────────────────────────────────────────────────────
결함 2. 가장자리에 배경색이 섞임  (궁수)
────────────────────────────────────────────────────────────────────
밝은 배경에서 잘라내며 실루엣 경계 픽셀에 배경색이 남았다. 알파 마스크 자체는
매끈하지만 머리카락 가닥 사이에 밝은 회색이 불투명하게 포함돼, 어두운 게임
배경 위에서 흰 후광처럼 번져 보인다.

  → 경계 BAND px 이내에서, 오염되지 않은 내부의 최근접 색보다 LUMA_GAP 이상
    밝은 픽셀만 그 참조색으로 교체한다.

  '참조색보다 밝을 때만'이 안전장치다. 흰 소매처럼 원래 밝은 부위는 참조색도
  밝아 휘도 차가 작으므로 교체되지 않는다.

사용법:  python3 tools/fix_sprites.py [--check] [파일...]
        --check 를 주면 수정하지 않고 진단 결과만 출력한다.
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

# 스프라이트 시트 격자 (index_mobile.html의 drawSpriteSheet 호출과 일치해야 함)
COLS, ROWS = 4, 3

CORE_A   = 200   # 확실한 전경으로 볼 알파
LUMA_T   = 6     # 이 휘도 이하는 '그려지지 않은 검은 배경'
DARK_T   = 90    # 이 휘도 미만만 알파 복구 대상
SAT_T    = 30    # 이 채도 이상은 복구 제외(VFX가 몸에 겹쳐 물든 픽셀)
EDGE_PX  = 1     # 외곽 안티앨리어싱 보존 폭
BAND     = 3     # 가장자리 오염 후보 폭(px)
LUMA_GAP = 38    # 참조색보다 이만큼 밝으면 오염으로 판정
SOLID_A  = 250

TARGETS = [
    'assets/PC_여도사.png', 'assets/PC_검객.png', 'assets/PC_여궁수_2.png',
    'assets/NPC_근접좀비.png', 'assets/NPC_돌진좀비.png',
    'assets/NPC_원거리좀비.png', 'assets/NPC_탱커좀비.png',
]


def repair_alpha(rgb, al):
    """결함 1: 잘못 깎인 어두운 영역의 알파를 되돌린다."""
    luma = rgb.max(axis=2)
    core = al >= CORE_A
    if not core.any():
        return al
    lab, n = ndimage.label((luma > LUMA_T) | core)
    keep = np.zeros(n + 1, bool)
    keep[np.unique(lab[core])] = True
    keep[0] = False
    body = ndimage.binary_closing(keep[lab], structure=np.ones((3, 3)))

    # 어둡고(=키잉에 잘못 먹힌) 무채색인 픽셀만 복구 대상.
    # 채도 조건이 없으면 참격 호가 몸에 겹친 부분까지 불투명해져 탁한 얼룩이 남는다.
    sat = rgb.max(axis=2).astype(int) - rgb.min(axis=2).astype(int)
    target = body & (luma < DARK_T) & (sat < SAT_T)
    inner = ndimage.binary_erosion(body, structure=np.ones((2*EDGE_PX+1,)*2))
    out = al.copy()
    out[target & inner] = 255
    ring = target & ~inner                 # 깎여나간 윤곽만 살짝 복원
    out[ring] = np.maximum(al[ring], 128)
    return out


def defringe(rgb, al):
    """결함 2: 경계에 남은 배경색을 인접 내부 색으로 교체한다."""
    solid = al >= SOLID_A
    if solid.sum() < 50:
        return rgb
    dist = ndimage.distance_transform_edt(solid)
    band, clean = solid & (dist <= BAND), solid & (dist > BAND)
    if clean.sum() < 50 or not band.any():
        return rgb
    _, idx = ndimage.distance_transform_edt(~clean, return_indices=True)
    ref = rgb[idx[0], idx[1]]
    contaminated = band & ((rgb.max(axis=2).astype(int) - ref.max(axis=2).astype(int)) >= LUMA_GAP)
    out = rgb.copy()
    out[contaminated] = ref[contaminated]
    return out


def interior_semi_ratio(al):
    """진단용: 외곽선을 제외한 '몸통 내부'에서 반투명 픽셀이 차지하는 비율(%)."""
    inner = ndimage.binary_erosion(
        ndimage.binary_fill_holes(ndimage.binary_closing(al > 0, structure=np.ones((9, 9)))),
        structure=np.ones((17, 17)))
    return 0.0 if not inner.any() else float((al[inner] < 250).mean() * 100)


def bright_fringe_px(rgb, al):
    """진단용: 인접 내부보다 뚜렷하게 밝은 경계 픽셀 수(= 흰 후광)."""
    solid, edge = al >= 250, (al > 20) & (al < 200)
    if not solid.any() or not edge.any():
        return 0
    luma = rgb.max(axis=2).astype(float)
    near = ndimage.grey_dilation(np.where(solid, luma, 0), size=(7, 7))
    e = edge & (near > 0)
    return int(((luma[e] - near[e]) > 40).sum())


def process(path, check_only=False):
    a = np.array(Image.open(path).convert('RGBA'))
    H, W = a.shape[:2]
    fw, fh = W // COLS, H // ROWS
    before = (interior_semi_ratio(a[..., 3]), bright_fringe_px(a[..., :3], a[..., 3]))
    if check_only:
        return before, before

    for r in range(ROWS):
        for c in range(COLS):
            ys, xs = slice(r*fh, (r+1)*fh), slice(c*fw, (c+1)*fw)
            # 순서 주의: 실루엣을 먼저 바로잡아야 defringe의 '경계'가 올바르게 잡힌다.
            a[ys, xs, 3] = repair_alpha(a[ys, xs, :3], a[ys, xs, 3])
            a[ys, xs, :3] = defringe(a[ys, xs, :3], a[ys, xs, 3])

    Image.fromarray(a).save(path, optimize=True)
    after = (interior_semi_ratio(a[..., 3]), bright_fringe_px(a[..., :3], a[..., 3]))
    return before, after


def main():
    args = [x for x in sys.argv[1:] if not x.startswith('--')]
    check = '--check' in sys.argv
    files = args or TARGETS
    print(f"{'파일':24s} {'내부 반투명(%)':>20s} {'흰 후광(px)':>18s}")
    for f in files:
        b, a = process(f, check)
        name = f.split('/')[-1]
        if check:
            print(f"{name:24s} {b[0]:12.2f}        {b[1]:12d}")
        else:
            print(f"{name:24s} {b[0]:7.2f} → {a[0]:<7.2f} {b[1]:8d} → {a[1]:<7d}")


if __name__ == '__main__':
    main()
