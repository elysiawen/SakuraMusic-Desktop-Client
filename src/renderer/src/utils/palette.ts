/**
 * 从封面图提取一对主/辅色，供沉浸式歌词页的流体渐变背景使用。
 *
 * 封面都经过 `cachedImage()` 改写成同源 `/media/cover` 地址，canvas 读取不会被污染；
 * 万一污染或加载失败，返回 null，调用方退回主题色。
 */

export interface CoverPalette {
  /** 主色：取封面里饱和部分的平均色相，调到大面积铺底友好的亮度。 */
  primary: string;
  /** 辅色：主色色相偏移一截，制造渐变的层次。 */
  secondary: string;
}

const SAMPLE_SIZE = 48;
const paletteCache = new Map<string, Promise<CoverPalette | null>>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      break;
    case g:
      h = ((b - r) / d + 2) * 60;
      break;
    default:
      h = ((r - g) / d + 4) * 60;
  }
  return [h, s, l];
}

async function sample(url: string): Promise<CoverPalette | null> {
  const image = new Image();
  image.decoding = 'async';
  const loaded = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
  if (!loaded) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    // 两遍统计：先求整体平均做兜底，再对「有颜色」的像素做饱和加权平均。
    let totalWeight = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let plainR = 0;
    let plainG = 0;
    let plainB = 0;
    let plainCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = (data[i] ?? 0) / 255;
      const g = (data[i + 1] ?? 0) / 255;
      const b = (data[i + 2] ?? 0) / 255;
      const a = (data[i + 3] ?? 255) / 255;
      if (a < 0.5) continue;
      plainR += r;
      plainG += g;
      plainB += b;
      plainCount += 1;
      const [, s, l] = rgbToHsl(r, g, b);
      // 灰白黑对「氛围色」没有贡献，权重趋零；饱和且中等亮度的像素说了算。
      const weight = a * s * (1 - Math.abs(l - 0.5) * 1.4);
      if (weight <= 0) continue;
      totalWeight += weight;
      sumR += r * weight;
      sumG += g * weight;
      sumB += b * weight;
    }

    let r: number;
    let g: number;
    let b: number;
    if (totalWeight > 0.01) {
      r = sumR / totalWeight;
      g = sumG / totalWeight;
      b = sumB / totalWeight;
    } else if (plainCount > 0) {
      r = plainR / plainCount;
      g = plainG / plainCount;
      b = plainB / plainCount;
    } else {
      return null;
    }

    const [h, s, l] = rgbToHsl(r, g, b);
    // 铺底友好化：饱和度抬高一点保证「有颜色」，亮度压在中段，避免背景发白或死黑。
    const sat = Math.min(0.85, Math.max(0.38, s * 1.35));
    const light = Math.min(0.6, Math.max(0.32, l));
    const h2 = (h + 46) % 360;
    return {
      primary: `hsl(${Math.round(h)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`,
      secondary: `hsl(${Math.round(h2)} ${Math.round(Math.min(0.9, sat + 0.1) * 100)}% ${Math.round(
        Math.min(0.66, light + 0.08) * 100,
      )}%)`,
    };
  } catch {
    // 画布被污染（理论不会，封面同源）：退回主题色。
    return null;
  }
}

/** 同一封面只取一次色；失败的 null 也缓存，避免反复加载。 */
export function extractPalette(url: string): Promise<CoverPalette | null> {
  const cached = paletteCache.get(url);
  if (cached) return cached;
  const task = sample(url);
  paletteCache.set(url, task);
  return task;
}
