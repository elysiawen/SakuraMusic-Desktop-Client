import type { BindGroup, Texture } from 'pixi.js';

// src/components/visualizer/pixi/pixiFilterPoolCompat.ts
// Pixi prunes screen-sized filter textures while FilterSystem still references the last pass:
// its bind group keeps the texture bound. 8.21.0 had a second bug - a reused filter stack entry
// kept a stale input texture that push() read to find the enclosing filter's resolution; PR 12257
// removed that lookup in 8.22.0, so the push patch below installs only where the old lookup exists.
// The bind group fix (PR 12259, after 8.22.0) is still needed on 8.22.0.
// https://github.com/pixijs/pixijs/pull/12259
// https://github.com/pixijs/pixijs/pull/12257
//
// No VERSION gate: the shim checks every internal it is about to patch and quietly does nothing
// when the shape changes, so a future Pixi upgrade degrades to normal rendering instead of taking
// the whole visualizer down.
type PixiModule = typeof import('pixi.js');
const PATCHED = Symbol.for('folia.pixi821FilterPoolCompat');

interface FilterSystemCompat {
    _globalFilterBindGroup: BindGroup;
    _filterStack: { inputTexture: Texture | null }[];
    _filterStackIndex: number;
    init?: () => void;
    push: (instruction: unknown) => void;
    destroy: () => void;
    /** 8.21.0 的旧查找：push() 会回看上一帧 stack entry 的 inputTexture，8.22.0 起已删除。 */
    _findFilterResolution?: (...args: unknown[]) => unknown;
    [PATCHED]?: boolean;
}

interface TexturePoolCompat {
    _poolKey: Record<number, number | undefined>;
    _buckets: Map<number, Texture[]>;
    _dropTextures: (textures: Texture[], destroy: boolean) => void;
    returnTexture: (texture: Texture, resetStyle?: boolean) => void;
}

/** Unbind all live renderers before the shared pool destroys textures; keep normal draws unchanged. */
export const installPixiFilterPoolCompat = (pixi: PixiModule) => {
    const prototype = pixi.FilterSystem?.prototype as unknown as FilterSystemCompat | undefined;
    const pool = pixi.TexturePool as unknown as TexturePoolCompat | undefined;
    const emptySource = pixi.Texture?.EMPTY?.source;
    const bindGroup = pixi.BindGroup as unknown as { prototype?: { setResource?: unknown } } | undefined;
    // 结构探测：下面要改的字段/方法逐项验一遍。形状变了就原路返回，让 Pixi 按自己的逻辑跑。
    if (!prototype || prototype[PATCHED] || !pool || !emptySource?.style
        || typeof prototype.push !== 'function' || typeof prototype.destroy !== 'function'
        || typeof bindGroup?.prototype?.setResource !== 'function'
        || typeof pool._dropTextures !== 'function' || typeof pool.returnTexture !== 'function'
        || !pool._poolKey || !(pool._buckets instanceof Map)) return;
    prototype[PATCHED] = true;

    const needsStackEntryFix = typeof prototype._findFilterResolution === 'function';
    const groups = new Set<BindGroup>();
    const unbindPassTextures = () => {
        groups.forEach(group => {
            group.setResource(emptySource, 1);
            group.setResource(emptySource.style, 2);
            group.setResource(emptySource, 3);
        });
    };

    // init is picked up by Pixi's renderer runner before any filter is rendered.
    const init = prototype.init;
    prototype.init = function () {
        init?.call(this);
        groups.add(this._globalFilterBindGroup);
    };
    const destroy = prototype.destroy;
    prototype.destroy = function () {
        groups.delete(this._globalFilterBindGroup);
        this._globalFilterBindGroup.destroy();
        destroy.call(this);
    };
    // 只有旧的 push() 需要清 stale input：它先占 stack entry，再回看 enclosing filter 的分辨率，
    // 于是嵌套滤镜读到上一帧那个 entry 的 input（可能已被池子销毁）。清掉它让查找退回根分辨率。
    // 8.22.0 起 _findFilterResolution / _calculateGlobalFrame 已被删掉（PR 12257），再清就是
    // 动一个正在用的 entry，所以这里按能力装，不按版本装。
    if (needsStackEntryFix) {
        const push = prototype.push;
        prototype.push = function (instruction) {
            const entry = this._filterStack[this._filterStackIndex];
            if (entry) entry.inputTexture = null;
            push.call(this, instruction);
        };
    }

    // Resize, renderer destruction and clear() all discard idle textures through this method.
    const dropTextures = pool._dropTextures;
    pool._dropTextures = function (textures, shouldDestroy) {
        if (shouldDestroy && textures.length > 0) unbindPassTextures();
        dropTextures.call(this, textures, shouldDestroy);
    };
    // A checked-out texture can outlive its bucket and be destroyed directly on return.
    const returnTexture = pool.returnTexture;
    pool.returnTexture = function (texture, resetStyle) {
        const key = this._poolKey[texture.uid];
        if (key !== undefined && !this._buckets.has(key)) unbindPassTextures();
        returnTexture.call(this, texture, resetStyle);
    };
};
