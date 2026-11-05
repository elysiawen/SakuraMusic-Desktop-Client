<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { EntitlementPlatform } from '@/api/rooms';
import AppIcon from '@/components/common/AppIcon.vue';
import { useToast } from '@/composables/useToast';
import { useRoomStore } from '@/stores/room';
import { formatTime } from '@/utils/format';

/**
 * 一起听（双人房）。
 *
 * 房间是**服务端权威**的共享现场：这里点播放/切歌只是把操作提交给网关，真正的状态
 * 由 `rooms` store 从 SSE 推回来再镜像到播放器。所以页面本身不持有任何播放状态，
 * 全部读 store。
 */
const room = useRoomStore();
const toast = useToast();

const joinCode = ref('');
const busy = ref(false);
/** 把播放从另一台设备接回本机时，按钮要有个「进行中」。 */
const transferring = ref(false);
/** 结束房间要二次确认（没有通用 confirm 弹窗，就地做一次态）。 */
const confirmingEnd = ref(false);
let confirmTimer: number | undefined;

/** 每秒走一下：时长与进度都要自己动，不能等服务端推。 */
const tick = ref(0);
let tickTimer: number | undefined;

const partnerOnline = computed(() => room.partner?.online === true);
const position = computed(() => {
  void tick.value;
  return room.livePosition();
});
const duration = computed(() => room.playback?.duration ?? 0);

const sessionText = computed(() => {
  void tick.value;
  return formatTime(room.togetherSessionLive());
});
const totalText = computed(() => {
  void tick.value;
  return formatTime(room.togetherLive());
});

/* ---------------- 曲目展示 ---------------- */

const cover = computed(() => room.currentTrack?.cover ?? '');
const trackTitle = computed(() => room.currentTrack?.title ?? '房间里还没有歌曲');
const trackArtists = computed(() => room.currentTrack?.artists ?? '从对方的队列开始');
const trackAlbum = computed(() => room.currentTrack?.album ?? '');

/** 房间状态的一句话（顶部胶囊）。 */
const roomStateText = computed(() => {
  if (!room.active) return '未加入房间';
  if (room.spectating) return '旁观中';
  return room.playing ? '同步播放中' : '已暂停';
});

/** 邀请链接：桌面端是 hash 路由，带上房间码打开即入房。 */
const inviteLink = computed(() =>
  room.code ? `${window.location.origin}${window.location.pathname}#/together?code=${room.code}` : '',
);

function initial(nickname: string): string {
  return nickname.trim().slice(0, 1) || '友';
}

async function run(task: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await task();
  } finally {
    busy.value = false;
  }
}

function createRoom(): void {
  void run(() => room.create());
}

function joinRoom(): void {
  const code = joinCode.value.trim();
  if (!code) return;
  void run(async () => {
    await room.join(code);
    joinCode.value = '';
  });
}

async function copyCode(): Promise<void> {
  if (!room.code) return;
  try {
    await navigator.clipboard.writeText(room.code);
    toast.success('房间码已复制');
  } catch {
    toast.info(`房间码：${room.code}`);
  }
}

async function copyInvite(): Promise<void> {
  if (!inviteLink.value) return;
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    toast.success('邀请链接已复制');
  } catch {
    toast.info(`房间码：${room.code}`);
  }
}

/** 结束房间：双人房里一个人结束，双方都退出。 */
async function endRoom(): Promise<void> {
  if (!confirmingEnd.value) {
    confirmingEnd.value = true;
    window.clearTimeout(confirmTimer);
    confirmTimer = window.setTimeout(() => {
      confirmingEnd.value = false;
    }, 3000);
    return;
  }
  confirmingEnd.value = false;
  window.clearTimeout(confirmTimer);
  await room.dissolve();
}

function leaveRoom(): void {
  void room.leave();
}

function toggle(): void {
  room.toggle();
}

/** 旁观时把播放接回本机（就是 join 接席位）。 */
async function transferHere(): Promise<void> {
  if (transferring.value) return;
  transferring.value = true;
  try {
    await room.transfer();
  } finally {
    transferring.value = false;
  }
}

/* ---- 会员共享（按平台分开） ---- */

const PLATFORM_LABEL: Record<EntitlementPlatform, string> = {
  netease: '网易云音乐',
  qq: 'QQ 音乐',
};

const SHARE_PLATFORMS: EntitlementPlatform[] = ['netease', 'qq'];

/** 我的账号 id：判断某一行是「我在提供」还是「在用对方的」。 */
const myUserId = computed(() => room.accountMember?.userId ?? null);

/** 两个平台各一行，三选一的当前值。 */
const shareRows = computed(() =>
  SHARE_PLATFORMS.map((platform) => ({
    platform,
    label: PLATFORM_LABEL[platform],
    ownerId: room.entitlement.active[platform] ?? null,
  })),
);

/** 需要**我**点头的请求：对方想用我的会员。 */
const pendingForMe = computed(() => room.entitlementRequestsForMe);

/** 我发出去、还没被确认的请求。 */
const pendingFromMe = computed(() =>
  SHARE_PLATFORMS.map((platform) => room.entitlement.pending[platform]).filter(
    (item) => Boolean(item && item.requestedBy === myUserId.value),
  ),
);

/** 我正在提供权益的平台（用于常驻提示，避免忘了自己开着共享）。 */
const sharedByMe = computed(() => room.mySharedPlatforms.map((platform) => PLATFORM_LABEL[platform]));

/** 正在借用对方的平台。 */
const borrowedLabels = computed(() =>
  SHARE_PLATFORMS.filter(
    (platform) =>
      Boolean(room.partner?.userId) && room.entitlement.active[platform] === room.partner?.userId,
  ).map((platform) => PLATFORM_LABEL[platform]),
);

/**
 * 唯一一行状态说明。
 *
 * 面板里只留**必须说**的那句：等待对方确认（功能性的），或「你的播放会被记账」（合规性的）。
 * 借用中那条在设备页/播放器上更合适；桌面端这里顺手说一句，否则共享开了也看不出来。
 */
const shareStatus = computed(() => {
  if (pendingFromMe.value.length) {
    const labels = pendingFromMe.value.map((item) => (item ? PLATFORM_LABEL[item.platform] : ''));
    return `已发出请求，等 TA 确认${labels.join('、')}`;
  }
  if (sharedByMe.value.length) return 'TA 的播放会记在你的账号下';
  if (borrowedLabels.value.length) return `正在使用 TA 的${borrowedLabels.value.join('、')}会员`;
  return '';
});

/** 等待我确认的平台（弹窗展示风险告知）。 */
const shareConfirm = ref<EntitlementPlatform | null>(null);
const confirmLabel = computed(() => (shareConfirm.value ? PLATFORM_LABEL[shareConfirm.value] : ''));

/**
 * 切换某平台的权益归属。
 *
 * 选对方时只是**发起请求**：真正需要知情并承担风险的是对方，由 TA 在自己的界面上确认。
 */
function chooseShare(platform: EntitlementPlatform, targetUserId: string | null): void {
  const current = room.entitlement.active[platform] ?? null;
  const pending = room.entitlement.pending[platform] ?? null;
  // 已经是这个状态、或已经发过同一个请求：不重复打扰服务端和对方。
  if (current === targetUserId) return;
  if (targetUserId && pending?.targetUserId === targetUserId) return;

  room.setEntitlement(platform, targetUserId);
  if (targetUserId && targetUserId !== myUserId.value) {
    toast.info('已发起请求，等待 TA 确认');
  }
}

function askShare(platform: EntitlementPlatform): void {
  shareConfirm.value = platform;
}

/** 同意：先关弹窗，再提交确认。 */
function confirmShare(): void {
  const platform = shareConfirm.value;
  shareConfirm.value = null;
  if (platform) room.ackEntitlement(platform, true);
}

function rejectShare(platform: EntitlementPlatform): void {
  room.ackEntitlement(platform, false);
}

/* ---- 进度 ---------------- */

/** 拖动中的临时进度：松手前不让每秒的 tick 把滑块拽回房间位置。 */
const seekDraft = ref<number | null>(null);
const shownPosition = computed(() => seekDraft.value ?? position.value);

/** 进度条的填充比例（%）。 */
const progressPercent = computed(() => {
  const total = duration.value;
  return total > 0 ? Math.min(100, Math.max(0, (shownPosition.value / total) * 100)) : 0;
});

function onSeekInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) seekDraft.value = value;
}

function onSeekDone(): void {
  const value = seekDraft.value;
  seekDraft.value = null;
  if (value !== null) room.seek(value);
}

onMounted(() => {
  // 从邀请链接进来：把房间码填好，用户点一下「加入」即可（不自动入房，避免误把席位抢走）。
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const invited = query.get('code');
  if (invited) joinCode.value = invited.toUpperCase();

  tickTimer = window.setInterval(() => {
    tick.value += 1;
  }, 1000);
});

onBeforeUnmount(() => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer);
  window.clearTimeout(confirmTimer);
});
</script>

<template>
  <div class="together-view">
    <header class="hero">
      <span class="hero-glow" />
      <div class="hero-main">
        <p class="eyebrow">一起听 · 双人房</p>
        <h1>两人，同一首歌</h1>
        <p class="hero-desc">
          房间里的播放由服务器统一推进：任一方都能切歌、暂停、拖动进度，两边听到的始终是同一秒。
          音频不转发，各自用自己账号取流。
        </p>
      </div>
      <div class="hero-side">
        <span class="chip" :class="{ live: room.active }">
          <AppIcon name="users" :size="12" />
          {{ roomStateText }}
        </span>
      </div>
    </header>

    <!-- ---------- 未入房 ---------- -->
    <section v-if="!room.active" class="entry">
      <article class="entry-card is-create">
        <span class="entry-badge"><AppIcon name="users" :size="18" /></span>
        <h2>开一间房</h2>
        <p class="entry-desc">
          创建后把房间码发给对方。房间会带着你现在的队列一起开，进来就是同一首歌。
        </p>
        <button type="button" class="btn primary entry-btn" :disabled="busy" @click="createRoom">
          <AppIcon name="sparkles" :size="14" />
          创建双人一起听
        </button>
      </article>

      <article class="entry-card">
        <span class="entry-badge"><AppIcon name="link" :size="18" /></span>
        <h2>加入对方的房间</h2>
        <p class="entry-desc">输入对方给的 6 位房间码，两边就会同步到同一首歌。</p>
        <div class="join-row">
          <input
            v-model="joinCode"
            class="input code"
            type="text"
            maxlength="6"
            placeholder="房间码"
            @keyup.enter="joinRoom"
          />
          <button type="button" class="btn" :disabled="busy || !joinCode.trim()" @click="joinRoom">
            加入
          </button>
        </div>
      </article>
    </section>

    <!-- ---------- 已入房 ---------- -->
    <template v-else>
      <!-- 房间条：码 + 状态 + 复制入口 -->
      <section class="room-bar">
        <div class="room-code-block">
          <span class="room-label">房间码</span>
          <strong class="room-code">{{ room.code }}</strong>
        </div>

        <span class="room-state" :class="{ live: partnerOnline }">
          <span class="pulse" />
          {{ partnerOnline ? '两端在线' : room.partner ? '对方离线' : '等待好友加入' }}
        </span>

        <div class="room-actions">
          <button type="button" class="mini" @click="copyCode">
            <AppIcon name="link" :size="12" />
            复制房间码
          </button>
          <button type="button" class="mini" @click="copyInvite">
            <AppIcon name="link" :size="12" />
            复制邀请链接
          </button>
        </div>
      </section>

      <div class="room-grid">
        <div class="col-main">
          <!-- 两人对置 -->
          <section class="pair">
            <div class="side">
              <span class="avatar is-me">
                <img v-if="room.accountMember?.avatar" :src="room.accountMember.avatar" alt="" />
                <template v-else>{{ initial(room.accountMember?.nickname ?? '我') }}</template>
              </span>
              <strong>{{ room.accountMember?.nickname ?? '我' }}</strong>
              <small>{{ room.accountMember?.deviceName ?? '本机' }}</small>
            </div>

            <div class="link" :class="{ live: partnerOnline }">
              <AppIcon name="link" :size="13" />
              <span>{{ partnerOnline ? '同步中' : room.partner ? '等待重连' : '等待中' }}</span>
            </div>

            <div class="side">
              <template v-if="room.partner">
                <span class="avatar partner" :class="{ offline: !partnerOnline }">
                  <img v-if="room.partner.avatar" :src="room.partner.avatar" alt="" />
                  <template v-else>{{ initial(room.partner.nickname) }}</template>
                  <span class="online-dot" :class="{ on: partnerOnline }" />
                </span>
                <strong>{{ room.partner.nickname }}</strong>
                <small>{{ partnerOnline ? room.partner.deviceName : '暂时离线' }}</small>
              </template>
              <template v-else>
                <span class="avatar empty"><AppIcon name="plus" :size="16" /></span>
                <strong>等待好友</strong>
                <small>把房间码发给 TA</small>
              </template>
            </div>
          </section>

          <!-- 播放舞台 -->
          <section class="stage" :class="{ spectating: room.spectating }">
            <span
              v-if="cover"
              class="stage-glow"
              :style="{ '--art': `url(${cover})` }"
            />

            <header class="stage-head">
              <span class="cover" :class="{ 'is-playing': room.playing }">
                <img v-if="cover" :src="cover" alt="" />
                <AppIcon v-else name="music" :size="30" :stroke-width="1.35" />
                <span v-if="room.playing" class="eq" aria-hidden="true"><i /><i /><i /></span>
              </span>

              <div class="stage-copy">
                <span class="stage-kicker">正在播放</span>
                <strong class="stage-title truncate" :title="trackTitle">{{ trackTitle }}</strong>
                <span class="stage-artist truncate">{{ trackArtists }}</span>
                <span v-if="trackAlbum" class="stage-album truncate">{{ trackAlbum }}</span>
              </div>

              <span class="state-chip" :class="{ live: room.playing }">
                {{ room.playing ? '播放中' : '已暂停' }}
              </span>
            </header>

            <div class="progress">
              <span class="time">{{ formatTime(shownPosition) }}</span>
              <input
                class="range"
                type="range"
                min="0"
                :max="Math.max(1, Math.floor(duration))"
                step="1"
                :value="Math.floor(shownPosition)"
                :style="{ '--fill': `${progressPercent}%` }"
                :disabled="!room.currentTrack || room.spectating"
                aria-label="播放进度"
                @input="onSeekInput"
                @change="onSeekDone"
              />
              <span class="time">{{ formatTime(duration) }}</span>
            </div>

            <!-- 席位在本机：传输控制交给房间，本机只镜像 -->
            <div v-if="!room.spectating" class="controls">
              <button type="button" class="ctrl" aria-label="上一首" title="上一首" @click="room.prev()">
                <AppIcon name="prev" :size="15" filled />
              </button>
              <button
                type="button"
                class="ctrl big"
                :aria-label="room.playing ? '暂停' : '播放'"
                :title="room.playing ? '暂停' : '播放'"
                @click="toggle"
              >
                <AppIcon :name="room.playing ? 'pause' : 'play'" :size="19" filled />
              </button>
              <button type="button" class="ctrl" aria-label="下一首" title="下一首" @click="room.next()">
                <AppIcon name="next" :size="15" filled />
              </button>
            </div>

            <!-- 旁观：播放挂在同账号的另一台设备上 -->
            <div v-else class="spectate-bar">
              <span class="spectate-text">
                <AppIcon name="monitor" :size="14" />
                <span class="truncate">
                  正在「{{ room.accountMember?.deviceName ?? '你的另一台设备' }}」上播放
                </span>
              </span>
              <button
                type="button"
                class="btn primary"
                :disabled="transferring"
                @click="transferHere"
              >
                {{ transferring ? '正在转移…' : '转到本机播放' }}
              </button>
            </div>
          </section>
        </div>

        <aside class="col-side">
          <!-- 一起听时长：只对双人房有意义（两人都在时走表） -->
          <section
            v-if="room.togetherCounting || room.togetherSessionSeconds > 0"
            class="stats-card"
          >
            <div class="stat">
              <span class="stat-label"><AppIcon name="clock" :size="12" /> 本次</span>
              <strong>{{ sessionText }}</strong>
            </div>
            <span class="stat-divider" />
            <div class="stat">
              <span class="stat-label"><AppIcon name="users" :size="12" /> 累计</span>
              <strong>{{ totalText }}</strong>
            </div>
            <p class="stat-note">只要两个人都在房间里就走表，暂停、发呆的时间都算。</p>
          </section>

          <!--
            会员共享：两个平台各一行三选一。
            默认「各自」；选「用 TA 的」只是发起请求，必须 TA 本人确认才生效。
          -->
          <section v-if="!room.spectating && room.partner" class="share">
            <header class="share-head">
              <span class="share-title">
                <AppIcon name="sparkles" :size="13" />
                会员共享
              </span>
              <span
                class="share-info"
                title="会员状态来自平台账号，不代表任意歌曲可播（数字专辑、独家内容不随会员解锁）"
              >
                ?
              </span>
            </header>

            <div v-for="row in shareRows" :key="row.platform" class="share-row">
              <span class="share-label">{{ row.label }}</span>
              <div class="seg" role="group" :aria-label="`${row.label}会员`">
                <button
                  type="button"
                  class="seg-opt"
                  :class="{ 'is-on': !row.ownerId }"
                  @click="chooseShare(row.platform, null)"
                >
                  各自
                </button>
                <button
                  type="button"
                  class="seg-opt"
                  :class="{ 'is-on': Boolean(myUserId) && row.ownerId === myUserId }"
                  :disabled="!myUserId"
                  @click="chooseShare(row.platform, myUserId)"
                >
                  用我的
                </button>
                <button
                  type="button"
                  class="seg-opt"
                  :class="{ 'is-on': Boolean(row.ownerId) && row.ownerId === room.partner?.userId }"
                  :disabled="!room.partner"
                  @click="chooseShare(row.platform, room.partner?.userId ?? null)"
                >
                  用 TA 的
                </button>
              </div>
            </div>

            <!-- 全块唯一需要动手的地方：给边框和主按钮，别混在说明文字里。 -->
            <div v-for="item in pendingForMe" :key="item.platform" class="share-request">
              <span class="share-request-text">
                <AppIcon name="alert" :size="12" />
                {{ room.partner?.nickname ?? 'TA' }} 想用你的{{ PLATFORM_LABEL[item.platform] }}会员
              </span>
              <div class="share-request-actions">
                <button type="button" class="mini primary" @click="askShare(item.platform)">
                  同意
                </button>
                <button type="button" class="mini" @click="rejectShare(item.platform)">拒绝</button>
              </div>
            </div>

            <p v-if="shareStatus" class="share-status">{{ shareStatus }}</p>
          </section>

          <section class="actions">
            <button
              v-if="!room.spectating"
              type="button"
              class="mini danger wide"
              @click="endRoom"
            >
              <AppIcon name="logout" :size="13" />
              {{ confirmingEnd ? '再点一次结束' : '结束一起听' }}
            </button>
            <button type="button" class="mini wide" @click="leaveRoom">退出房间</button>
          </section>
        </aside>
      </div>
    </template>

    <!-- 借用会员的风险由被借用的一方承担：确认前把后果逐条说清。 -->
    <Teleport to="body">
      <div v-if="shareConfirm" class="share-mask" @click.self="shareConfirm = null">
        <div class="share-modal" role="dialog" aria-modal="true">
          <header class="share-modal-head">
            <p class="eyebrow">会员共享</p>
            <h2>把{{ confirmLabel }}的会员借给 TA？</h2>
          </header>

          <p class="share-modal-desc">同意后，TA 会用你的会员权益播放这一平台的歌。</p>

          <ul class="share-points">
            <li class="danger">可能违反平台协议，账号被限制或封禁</li>
            <li>TA 的播放会记在你账号的播放记录里</li>
            <li>会占用你账号的并发设备数</li>
          </ul>

          <p class="share-modal-note">随时可以切回「各自」，或退出房间来终止。</p>

          <footer class="share-modal-foot">
            <button type="button" class="mini" @click="shareConfirm = null">取消</button>
            <button type="button" class="mini primary" @click="confirmShare">同意共享</button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.together-view {
  display: flex;
  max-width: 1080px;
  margin: 0 auto;
  flex-direction: column;
  gap: 16px;
  animation: fade-up var(--dur-slow) var(--ease);
}

/* ---------------- 顶部 ---------------- */

.hero {
  position: relative;
  display: flex;
  overflow: hidden;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  padding: 26px 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(
      560px 240px at 5% 0%,
      color-mix(in srgb, var(--accent) 20%, transparent),
      transparent 70%
    ),
    linear-gradient(140deg, var(--surface-strong), color-mix(in srgb, var(--surface) 45%, transparent));
  box-shadow: var(--shadow-sm);
}

.hero-glow {
  position: absolute;
  top: -100px;
  right: -70px;
  width: 300px;
  height: 300px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--accent-2) 30%, transparent),
    transparent 68%
  );
  pointer-events: none;
}

.hero-main {
  position: relative;
  min-width: 0;
}

.hero h1 {
  margin-top: 4px;
  font-size: 27px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.hero-desc {
  max-width: 600px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.75;
}

.hero-side {
  position: relative;
  display: flex;
  align-items: center;
}

.chip.live {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---------------- 未入房 ---------------- */

.entry {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 14px;
}

.entry-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: linear-gradient(
    155deg,
    color-mix(in srgb, var(--surface-strong) 82%, transparent),
    color-mix(in srgb, var(--surface) 46%, transparent)
  );
  transition:
    border-color var(--dur) var(--ease),
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.entry-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}

/* 创建是主路径：给一层强调色底光，把注意力放在它上面。 */
.entry-card.is-create {
  border-color: color-mix(in srgb, var(--accent) 26%, var(--border));
  background:
    radial-gradient(
      360px 160px at 0% 0%,
      color-mix(in srgb, var(--accent) 16%, transparent),
      transparent 72%
    ),
    linear-gradient(155deg, var(--surface-strong), color-mix(in srgb, var(--surface) 44%, transparent));
}

.entry-badge {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--text-muted);
}

.entry-card.is-create .entry-badge {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.entry-card h2 {
  font-size: 16px;
  font-weight: 750;
}

.entry-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.7;
}

.entry-btn {
  margin-top: auto;
}

.join-row {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
}

.input.code {
  min-width: 0;
  flex: 1;
  text-transform: uppercase;
  letter-spacing: 3px;
  font-variant-numeric: tabular-nums;
}

/* ---------------- 房间条 ---------------- */

.room-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 13px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-hover);
}

.room-code-block {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.room-label {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 650;
}

.room-code {
  font-size: 19px;
  font-weight: 800;
  letter-spacing: 4px;
  font-variant-numeric: tabular-nums;
}

/* 在线时那颗点轻微呼吸：不喧宾夺主，但能看出「链接还活着」。 */
.room-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 650;
}

.room-state.live {
  color: var(--accent);
}

.pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
}

.room-state.live .pulse {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
  animation: pulse-dot 1.8s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.room-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

/* ---------------- 主区域 ---------------- */

.room-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  align-items: start;
  gap: 14px;
}

.col-main,
.col-side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
}

/* ---------------- 两人对置 ---------------- */

.pair {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 14px;
  padding: 20px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 46%, transparent);
}

.side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  text-align: center;
}

.side strong {
  max-width: 100%;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side small {
  max-width: 100%;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.avatar {
  position: relative;
  display: grid;
  width: 54px;
  height: 54px;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--accent);
  font-size: 18px;
  font-weight: 650;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 本机头像加一圈渐变描边，和对方区分开。 */
.avatar.is-me {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: var(--accent-soft);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent),
    0 10px 22px -14px color-mix(in srgb, var(--accent) 90%, transparent);
}

.avatar.partner {
  overflow: visible;
}

.avatar.partner img {
  overflow: hidden;
  border-radius: 50%;
}

.avatar.offline {
  opacity: 0.55;
}

.avatar.empty {
  border-style: dashed;
  color: var(--text-faint);
}

.online-dot {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 10px;
  height: 10px;
  border: 2px solid var(--surface-strong);
  border-radius: 50%;
  background: var(--border-strong);
}

.online-dot.on {
  background: #4caf7d;
}

.link {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 650;
  white-space: nowrap;
}

.link.live {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---------------- 播放舞台 ---------------- */

.stage {
  position: relative;
  display: flex;
  overflow: hidden;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--surface-strong) 88%, transparent),
    color-mix(in srgb, var(--surface) 52%, transparent)
  );
  box-shadow: var(--shadow-sm);
}

/* 封面本身的模糊底光：有封面才出现，只做氛围。 */
.stage-glow {
  position: absolute;
  top: -80px;
  right: -50px;
  left: -50px;
  height: 230px;
  background-image: var(--art);
  background-position: center 32%;
  background-size: cover;
  filter: blur(46px) saturate(1.2);
  opacity: 0.26;
  pointer-events: none;
}

.stage > *:not(.stage-glow) {
  position: relative;
  z-index: 1;
}

.stage-head {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
}

.cover {
  position: relative;
  display: grid;
  width: 92px;
  height: 92px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
  border-radius: 16px;
  background:
    radial-gradient(circle at 32% 26%, var(--accent-soft), transparent 64%),
    var(--surface);
  color: var(--text-faint);
  box-shadow: 0 18px 32px -20px rgba(0, 0, 0, 0.75);
  transition: box-shadow var(--dur) var(--ease);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover.is-playing {
  border-color: color-mix(in srgb, var(--accent) 42%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent) 34%, transparent),
    0 20px 36px -20px color-mix(in srgb, var(--accent) 85%, transparent);
}

/* 三根跳动的音量条：不用文字也能看出「它在出声」。 */
.eq {
  position: absolute;
  right: 7px;
  bottom: 7px;
  display: flex;
  height: 14px;
  align-items: flex-end;
  gap: 2px;
  padding: 3px 4px;
  border-radius: 6px;
  background: rgba(10, 10, 14, 0.5);
  backdrop-filter: blur(3px);
}

.eq i {
  width: 2.5px;
  height: 100%;
  border-radius: 2px;
  background: #fff;
  transform-origin: bottom;
  animation: eq-bounce 900ms ease-in-out infinite;
}

.eq i:nth-child(2) {
  animation-delay: -0.3s;
}

.eq i:nth-child(3) {
  animation-delay: -0.6s;
}

@keyframes eq-bounce {
  0%,
  100% {
    transform: scaleY(0.32);
  }
  50% {
    transform: scaleY(1);
  }
}

.stage-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.stage-kicker {
  color: var(--text-faint);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.stage-title {
  font-size: 16px;
  font-weight: 750;
  letter-spacing: -0.01em;
}

.stage-artist {
  color: var(--text-muted);
  font-size: 12px;
}

.stage-album {
  color: var(--text-faint);
  font-size: 10.5px;
}

.state-chip {
  flex: none;
  align-self: flex-start;
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 9.5px;
  font-weight: 650;
}

.state-chip.live {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---------------- 进度 ---------------- */

.progress {
  display: flex;
  align-items: center;
  gap: 9px;
}

.time {
  flex: none;
  min-width: 34px;
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.range {
  --fill: 0%;
  height: 6px;
  flex: 1;
  min-width: 0;
  appearance: none;
  -webkit-appearance: none;
  border-radius: 999px;
  background-image:
    linear-gradient(90deg, var(--accent), var(--accent-2)),
    linear-gradient(var(--border-strong), var(--border-strong));
  background-repeat: no-repeat;
  background-size:
    var(--fill) 100%,
    100% 100%;
  cursor: pointer;
  outline: none;
}

.range:disabled {
  cursor: default;
  opacity: 0.6;
}

.range::-webkit-slider-thumb {
  width: 11px;
  height: 11px;
  appearance: none;
  -webkit-appearance: none;
  border-radius: 50%;
  background: #fff;
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.3),
    0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.range:hover::-webkit-slider-thumb,
.range:active::-webkit-slider-thumb,
.range:focus-visible::-webkit-slider-thumb {
  opacity: 1;
  transform: none;
}

/* ---------------- 传输控制 ---------------- */

.controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding-top: 2px;
}

.ctrl {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--text-muted);
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.ctrl:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.ctrl:active {
  transform: scale(0.94);
}

/* 主播放键：整页唯一的大圆按钮。 */
.ctrl.big {
  width: 58px;
  height: 58px;
  border: none;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--accent-contrast, #fff);
  box-shadow: 0 16px 30px -16px color-mix(in srgb, var(--accent) 90%, transparent);
}

.ctrl.big:hover {
  color: var(--accent-contrast, #fff);
  filter: brightness(1.05);
}

/* ---------------- 旁观 ---------------- */

.spectate-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-top: 4px;
}

.spectate-text {
  display: inline-flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11.5px;
}

/* ---------------- 侧栏 ---------------- */

.stats-card {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-hover);
}

.stat {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.stat-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 650;
}

.stat strong {
  color: var(--accent);
  font-size: 19px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.stat-divider {
  width: 1px;
  height: 30px;
  background: var(--border-strong);
}

.stat-note {
  width: 100%;
  margin: 0;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.6;
}

/* ---------------- 会员共享 ---------------- */

.share {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(
      360px 130px at 0% 0%,
      color-mix(in srgb, var(--accent) 9%, transparent),
      transparent 72%
    ),
    color-mix(in srgb, var(--surface) 46%, transparent);
}

.share-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.share-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 700;
}

.share-info {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  color: var(--text-faint);
  font-size: 10px;
  cursor: help;
}

.share-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.share-label {
  color: var(--text-muted);
  font-size: 11.5px;
}

/* 三选一：整组一个药丸，选中项用强调色，比三个独立按钮更像「一选项」。 */
.seg {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--surface) 72%, transparent);
}

.seg-opt {
  height: 24px;
  padding: 0 9px;
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 650;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.seg-opt:hover:not(:disabled) {
  color: var(--text);
}

.seg-opt.is-on {
  background: var(--accent-soft);
  color: var(--accent);
}

.seg-opt:disabled {
  opacity: 0.4;
  cursor: default;
}

/* 唯一需要动手的地方：给边框和主按钮，别混在说明文字里。 */
.share-request {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: var(--radius-md);
  background: var(--accent-soft);
}

.share-request-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
  font-size: 11.5px;
}

.share-request-actions {
  display: flex;
  gap: 6px;
}

.share-status {
  margin: 0;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.6;
}

/* ---------------- 底部动作 ---------------- */

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.actions .wide {
  flex: 1;
  justify-content: center;
}

/* ---------------- 通用小件 ---------------- */

.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 27px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}

.mini:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.mini:disabled {
  opacity: 0.5;
  cursor: default;
}

.mini.primary {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.mini.danger {
  border-color: color-mix(in srgb, #e0453a 32%, transparent);
  color: #e0453a;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
  color: var(--text);
  font-size: 12px;
  font-weight: 650;
}

.btn.primary {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------- 风险告知弹窗 ---------------- */

.share-mask {
  position: fixed;
  z-index: var(--z-overlay);
  display: grid;
  inset: 0;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(6px);
}

.share-modal {
  display: flex;
  width: min(420px, 100%);
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background: var(--surface-strong);
  box-shadow: var(--shadow-lg);
  animation: fade-up var(--dur) var(--ease);
}

.share-modal h2 {
  margin-top: 3px;
  font-size: 16px;
  font-weight: 750;
}

.share-modal-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.share-points {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.share-points li {
  position: relative;
  padding-left: 14px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.6;
}

.share-points li::before {
  position: absolute;
  top: 6px;
  left: 2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--border-strong);
  content: '';
}

.share-points li.danger {
  color: #e0453a;
}

.share-points li.danger::before {
  background: #e0453a;
}

.share-modal-note {
  margin: 0;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.6;
}

.share-modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ---------------- 响应式 ---------------- */

@media (max-width: 980px) {
  .room-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  /* 单列时「时长 / 共享 / 动作」排在播放器后面，顺序仍然合理。 */
  .col-side {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    align-items: start;
  }
}

@media (max-width: 640px) {
  .pair {
    grid-template-columns: 1fr;
  }

  .share-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }

  .stage-head {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .cover {
    width: 76px;
    height: 76px;
  }

  .stat-divider {
    display: none;
  }
}
</style>
