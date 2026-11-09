import type { ApplicationOptions } from 'pixi.js';

// src/components/visualizer/pixi/pixiWebGLContext.ts
// Makes the WebGL context of a Pixi style before Pixi starts, as Pixi would make it, and switches on
// the extensions Pixi asks for a few at a time, the page running in between. Pixi switches on every
// extension it knows of at once when it starts; each one asks the GPU process twice and waits for the
// answers, and on four slow cores that held the main thread 60 to 80 ms. Handed this context, Pixi
// finds them on and its own asking costs nothing.
type PixiModule = typeof import('pixi.js');

/** The init options that decide the context's attributes (GlContextSystem.init). */
type ContextOptions = Pick<ApplicationOptions, 'backgroundAlpha' | 'antialias' | 'useBackBuffer' | 'powerPreference'>;

/**
 * The extensions Pixi 8.2x's GlContextSystem.getExtensions asks a WebGL 2 context for, in its order.
 * Pre-enabling an extra one is harmless (`getExtension` answers null); missing one only costs the
 * roundtrip Pixi would have paid anyway, so this list never has to match a version exactly.
 */
const PIXI_EXTENSIONS = [
    'EXT_texture_filter_anisotropic',
    'OES_texture_float_linear',
    'WEBGL_compressed_texture_s3tc',
    'WEBGL_compressed_texture_s3tc_srgb',
    'WEBGL_compressed_texture_etc',
    'WEBGL_compressed_texture_etc1',
    'WEBGL_compressed_texture_pvrtc',
    'WEBKIT_WEBGL_compressed_texture_pvrtc',
    'WEBGL_compressed_texture_atc',
    'WEBGL_compressed_texture_astc',
    'EXT_texture_compression_bptc',
    'EXT_texture_compression_rgtc',
    'WEBGL_lose_context',
    'EXT_color_buffer_float',
    'WEBGL_provoking_vertex',
    // linkPixiPrograms asks for it next.
    'KHR_parallel_shader_compile',
];
/** How long one task may switch extensions on: each takes two answers from the GPU process. */
const TASK_MS = 4;

const nextTask = () => new Promise((resolve) => { window.setTimeout(resolve); });

const cancelled = () => new DOMException('Pixi context creation was cancelled', 'AbortError');

/**
 * `{ canvas, context }` to add to Pixi's init options: a WebGL 2 context with the attributes Pixi
 * would ask for with `options`, its extensions on, made in a task of its own. Empty (Pixi makes the
 * context itself, as before) where a WebGL 2 context cannot be made. Throws an AbortError when
 * `signal` is aborted meanwhile, the context given back.
 *
 * Capability-based, not version-gated: 8.21 / 8.22 的 GlContextSystem 都吃 `options.context` +
 * `options.canvas`，扩展列表也一致。就算将来 Pixi 不认这两个选项，它只是自己另建一个上下文，
 * 不会画错；少预开一两个扩展也只是回退到原来的首帧耗时。
 */
export const makePixiContext = async (
    pixi: PixiModule,
    options: ContextOptions,
    signal?: AbortSignal,
): Promise<{ canvas?: HTMLCanvasElement; context?: WebGL2RenderingContext }> => {
    if (pixi.RendererType?.WEBGL === undefined) return {};
    await nextTask();
    if (signal?.aborted) throw cancelled();
    const canvas = document.createElement('canvas');
    // What GlContextSystem.init passes to getContext, with its defaults: premultiplied alpha, no
    // preserved drawing buffer; a back buffer takes the antialiasing over.
    let context: WebGL2RenderingContext | null = null;
    try {
        context = canvas.getContext('webgl2', {
            alpha: (options.backgroundAlpha ?? 1) < 1,
            premultipliedAlpha: true,
            antialias: Boolean(options.antialias) && !options.useBackBuffer,
            stencil: true,
            preserveDrawingBuffer: false,
            powerPreference: options.powerPreference ?? 'default',
        });
    } catch {
        return {};
    }
    if (!context) return {};
    const gl = context;
    let started = performance.now();
    for (const name of PIXI_EXTENSIONS) {
        if (performance.now() - started > TASK_MS) {
            await nextTask();
            if (signal?.aborted) {
                try {
                    gl.getExtension('WEBGL_lose_context')?.loseContext();
                } catch {
                    // The context is going away with the renderer anyway.
                }
                throw cancelled();
            }
            started = performance.now();
        }
        try {
            gl.getExtension(name);
        } catch {
            // An extension this driver refuses outright: Pixi asks again on its own context.
        }
    }
    return { canvas, context: gl };
};
