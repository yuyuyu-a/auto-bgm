'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cachePath, filterLibrary, readLibrary, writeLibrary, ANALYSIS_VERSION, ANALYSIS_SETTINGS, MODEL_SHA256 } = require('./music-library');
const { assertStoryTranscript, buildStoryMusicPlan, publicStoryProfile } = require('./story-music-plan');
const { buildLocalVisionMusicPlan } = require('./local-vision-plan');
const { loadStoryDocument, STORY_EXTENSIONS } = require('./story-input');
const { findSubtitleForVideo } = require('./subtitles');
const { withSampledVideoFrames } = require('./video-frames');
const { deduplicateMusic } = require('./music-dedup');
const { canonicalMood, chooseTrack, describeTrackSelection, findCompatibleMoodFolder, findMoodFolder, selectionReason } = require('./music-selection');
const { DEFAULT_MAX_TRACK_DURATION, DEFAULT_TRANSITION_FADE_SECONDS, enforceTrackDuration, maxTrackDuration, playbackWindows, transitionFadeSeconds } = require('./track-duration');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const DEFAULT_MOOD = '默认';
const STATE_VERSION = 14;
const PLANNING_VERSION = 'single-track-duration-v8-local-vision';

const MOOD_RULES = [
  { mood: '紧张', words: ['危险', '追杀', '逃跑', '快跑', '小心', '冲突', '打架', '绑架', '枪', '杀', '来不及', '怎么办', '救命', '别过来', 'danger', 'chase', 'run away', 'hurry', 'hurry up', 'careful', 'kidnap', 'kidnapped', 'gun', 'kill', 'killed', 'fight', 'fighting', "we're running out of time", 'what do we do', "don't come", "i'm scared", "i'm afraid", 'please help', 'help me', 'get out of here', 'we have to go', "they're coming", "we're trapped"] },
  { mood: '愤怒', words: ['愤怒', '怒火', '压迫', '反派', '威胁', '逼迫', '仇恨', '报复', '受够了', '别逼我', '无法原谅', '你竟敢', '怎么敢', 'angry', 'rage', 'threat', 'threaten', 'pressure', 'revenge', 'hate', 'bully', 'bullying', 'slap', 'slapped', 'humiliate', 'cruel', 'cruelty', 'hit me', 'told us to get out', "i've had enough", 'unforgivable', 'how dare', "how could you", 'you betrayed me', 'you lied to me', 'leave me alone', 'you have no right', "it's your fault", "i can't believe you"] },
  { mood: '悬疑', words: ['秘密', '线索', '调查', '监控', '真相', '发现', '证据', '怀疑', '凶手', '跟踪', 'secret', 'clue', 'investigate', 'investigation', 'monitor', 'truth', 'evidence', 'suspect', 'killer', 'follow', 'rumor', 'rumour', "something's wrong", 'what happened', 'who did this', "what's going on", "it doesn't make sense", 'bad feeling', 'we need to find out'] },
  { mood: '爽感', words: ['打脸', '反击', '报复', '赢了', '闭嘴', '滚', '道歉', '胜利', '反转', 'fight back', 'hit back', 'shut up', 'get out', 'apologize', 'apology', 'winner', 'victory', 'stand up', 'dare', 'we did it', 'we won', 'i won', 'finally', 'you lose', 'in your face', 'you got what you deserved', "that's what you get"] },
  { mood: '欢快', words: ['开心', '高兴', '欢乐', '轻松', '活泼', '笑', '庆祝', '太好了', '好开心', '笑死', 'happy', 'cheerful', 'fun', 'laugh', 'laughing', 'celebrate', 'celebration', 'smile', "that's great", 'so happy', "i'm so happy", 'this is amazing', 'great news', "we're safe", 'we made it', 'good news', "can't stop laughing"] },
  { mood: '浪漫', words: ['爱', '喜欢', '恋爱', '浪漫', '心动', '告白', '吻', '婚礼', '想和你', '只爱你', '心里只有', 'love', 'loves', 'romance', 'romantic', 'kiss', 'wedding', 'marry', 'married', 'wife', 'husband', 'i love you', 'i want to be with', 'you are mine', 'you mean everything to me', 'you are my world', 'will you marry me'] },
  { mood: '励志', words: ['梦想', '努力', '坚持', '成长', '成功', '希望', '加油', '不能放弃', '一定要', '相信自己', 'dream', 'work hard', 'keep going', 'growth', 'success', 'successful', 'hope', 'courage', 'support', "won't give up", 'i can do', 'i can do this', 'we can do this', 'keep fighting', 'believe in yourself', 'you can do it', "we'll get through this"] },
  { mood: '伤感', words: ['伤心', '难过', '哭', '眼泪', '离开', '失去', '对不起', '遗憾', '心痛', '不想离开', '再也见不到', '无法挽回', 'sad', 'sadness', 'sorry', 'cry', 'crying', 'tears', 'leave', 'left', 'lost', 'loss', 'regret', 'heartbroken', 'pain', 'stay for a couple of days', 'find a place', "can't let go", 'never see again', "it's over", 'goodbye', 'i lost you', 'you left me', "i can't go on", 'nothing will ever be the same', 'i wish you were here'] },
  { mood: '温情', words: ['谢谢', '家人', '妈妈', '爸爸', '拥抱', '爱你', '温柔', '陪着', '回家', '有我在', '我陪你', '别怕', '辛苦了', 'thank', 'thanks', 'family', 'mother', 'mom', 'father', 'dad', 'grandpa', 'grandmother', 'hug', 'gentle', 'stay with', 'go home', 'care', 'will you still come', 'we will', 'neither of you is going anywhere', 'not making us leave', 'stuck with me', 'real home', 'eat up', "nobody's holding back", "i'm here", 'you are not alone', "i'm here for you", 'i forgive you', "it's okay", 'take care', "i'm proud of you", "we're family"] },
  { mood: '忧郁', words: ['阴暗', '神秘', '诡异', '沉重', '孤独', 'dark', 'strange', 'lonely', 'heavy', 'gloomy', 'mysterious', 'mystery', 'nothing matters', "what's the point", "i'm all alone", 'no one cares', "it's too late", 'i feel empty'] },
];

function usage() {
  return `用法:
  node src/cli.js --videos <视频文件或目录> --music <BGM目录> --output <输出目录> [选项]

选项:
  --transcripts <目录>  读取与视频同名的 JSON 字幕时间段
  --transcribe           调用 tools/transcribe.py + faster-whisper（需另行安装 Python/依赖）
  --mood <标签>          覆盖自动情绪判断，必须匹配 BGM 子目录
  --allow-unverified-music  允许未确认曲目（默认严格纯音乐，首次分析请用桌面版）
  --no-auto-duck         关闭默认开启的对白压低
  --duck-db <-10>        对白时 BGM 增益，默认 -10
  --freeze-tail <秒:帧>  片尾定格时长，定格期间不铺 BGM，默认 0:00
  --max-track-duration <秒>  单曲连续播放上限，含淡出，默认 40；0 不限制
  --fade-in <秒>         首部淡入，默认 2
  --fade-out <秒>        尾部淡出，默认 2
  --overwrite            明确允许覆盖已有输出
  --ffmpeg <路径>        指定 ffmpeg 可执行文件
  --ffprobe <路径>       指定 ffprobe 可执行文件
  --help                 显示帮助

输出文件: <集名>_final.<原视频扩展名>（原视频画面 + 原音 + BGM）、_bgm.wav、_timeline.csv、_transcript.json。
BGM 目录约定:
  BGM/悬疑/*.mp3   BGM/紧张/*.wav   BGM/默认/*.mp3
  也支持直接放在 BGM/ 根目录，根目录曲目视为“默认”。`;
}

function parseArgs(argv) {
  const options = {
    videos: null,
    music: null,
    output: null,
    transcripts: null,
    transcribe: false,
    mood: null,
    autoDuck: true,
    strictInstrumental: true,
    duckDb: -10,
    freezeTail: '0:00',
    fadeIn: 2,
    fadeOut: 2,
    maxTrackDuration: DEFAULT_MAX_TRACK_DURATION,
    overwrite: false,
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
    ffprobe: process.env.FFPROBE || 'ffprobe',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--allow-unverified-music') { options.strictInstrumental = false; continue; }
    if (arg === '--no-auto-duck') { options.autoDuck = false; continue; }
    if (arg === '--transcribe' || arg === '--overwrite' || arg === '--auto-duck') {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`无法识别参数: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    if (!(key in options)) throw new Error(`无法识别参数: ${arg}`);
    if (['duckDb', 'fadeIn', 'fadeOut', 'maxTrackDuration'].includes(key)) {
      if (key === 'maxTrackDuration' && !value.trim()) throw new Error(`${arg} 必须是有效数字`);
      options[key] = Number(value);
      if (!Number.isFinite(options[key]) || options[key] < 0 && key !== 'duckDb') {
        throw new Error(`${arg} 必须是有效数字`);
      }
    } else {
      options[key] = value;
    }
  }

  for (const key of ['videos', 'music', 'output']) {
    if (!options[key]) throw new Error(`缺少必填参数 --${key}`);
  }
  if (options.duckDb > 0) throw new Error('--duck-db 应为 0 或负数');
  if (!/^\d+:\d+$/.test(options.freezeTail)) throw new Error('--freeze-tail 格式应为 秒:帧，例如 2:15');
  return options;
}

function naturalCompare(a, b) {
  return new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare(a, b);
}

function normalizePath(value) {
  return path.resolve(value);
}

async function canonicalPath(value) {
  let current = normalizePath(value);
  const suffix = [];
  while (true) {
    try {
      const resolved = path.join(await fs.realpath(current), ...suffix);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function fileIdentity(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.ino ? `${stat.dev}:${stat.ino}` : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function assertSourceTargetsSafe(sources, targets, label) {
  const paths = new Set();
  const identities = new Set();
  for (const source of new Set(sources)) {
    paths.add(await canonicalPath(source));
    const identity = await fileIdentity(source);
    if (identity) identities.add(identity);
  }
  for (const target of new Set(targets)) {
    const identity = await fileIdentity(target);
    if (paths.has(await canonicalPath(target)) || identity && identities.has(identity)) {
      throw Object.assign(new Error(`输出路径与${label}重合，已阻止覆盖；请选择独立输出目录：` + target), { code: 'SOURCE_OUTPUT_COLLISION' });
    }
  }
}

async function unresolvedStoryPaths(storyPath, videoPath) {
  if (!(await fs.stat(storyPath)).isDirectory()) return [storyPath];
  const stem = path.parse(videoPath).name.toLowerCase();
  // Keep unreadable or ambiguous matches protected using the loader's naming convention.
  const names = new Set(['', '.script', '.storyboard', '_script', '_storyboard', '.剧本', '.分镜', '_剧本', '_分镜'].map((suffix) => stem + suffix));
  return (await fs.readdir(storyPath))
    .filter((name) => STORY_EXTENSIONS.has(path.extname(name).toLowerCase()) && names.has(path.parse(name).name.toLowerCase()))
    .map((name) => path.join(storyPath, name));
}

async function assertStorySourcesSafe(options, targets, documentPaths) {
  if (!options.storyEnabled) return;
  const source = normalizePath(options.storyPath);
  const stat = await fs.stat(source);
  const sources = stat.isDirectory()
    ? documentPaths || (await fs.readdir(source)).filter((name) => STORY_EXTENSIONS.has(path.extname(name).toLowerCase())).map((name) => path.join(source, name))
    : [source];
  // Protect candidate documents even when matching or parsing fails.
  await assertSourceTargetsSafe(sources, targets, '剧本输入素材');
}

function episodeArtifacts(videoPath, outputDir) {
  const episode = path.parse(videoPath).name;
  const outputPath = path.join(outputDir, episode + '_bgm.wav');
  const timelinePath = path.join(outputDir, episode + '_timeline.csv');
  const extension = path.extname(videoPath).toLowerCase() || '.mp4';
  const finalVideoPath = path.join(outputDir, episode + '_final' + extension);
  const asrTranscriptPath = path.join(outputDir, episode + '_transcript.json');
  return {
    outputPath, timelinePath, finalVideoPath, asrTranscriptPath,
    tempOutputPath: outputPath + '.part.wav',
    tempTimelinePath: timelinePath + '.part',
    tempFinalVideoPath: path.join(outputDir, episode + '_final.part' + extension),
    tempTranscriptOutputPath: asrTranscriptPath + '.part',
    tempTranscriptPath: path.join(outputDir, '.tmp-' + episode + '-' + process.pid + '.transcript.json'),
  };
}

const ARTIFACT_KEYS = ['outputPath', 'finalVideoPath', 'timelinePath', 'transcriptPath'];

function storyFingerprintFor(options, document, subtitleStat, videoStat) {
  return createHash('sha256').update(JSON.stringify({
    enabled: Boolean(options.storyEnabled), document: document?.signature || null,
    profile: options.storyEnabled ? publicStoryProfile(options.storyAIProfile) : null,
    localVisionEnabled: Boolean(options.localVisionEnabled),
    subtitle: options.localVisionEnabled && subtitleStat
      ? [subtitleStat.path, subtitleStat.size, Math.trunc(subtitleStat.mtimeMs), Math.trunc(subtitleStat.ctimeMs), subtitleStat.contentSha256] : null,
    video: options.localVisionEnabled && videoStat
      ? [videoStat.size, Math.trunc(videoStat.mtimeMs), Math.trunc(videoStat.ctimeMs), Math.trunc(videoStat.birthtimeMs)] : null,
    modelRevision: options.localVisionEnabled ? options.localVisionModelRevision || '' : '',
    version: options.localVisionEnabled ? 'local-visual-srt-v1' : 'story-anchored-v1',
  })).digest('hex');
}

function artifactStoryFingerprints(entry) {
  const fingerprints = { ...entry?.artifactStoryFingerprints };
  for (const key of ARTIFACT_KEYS) {
    if (!entry?.[key] || Object.hasOwn(fingerprints, key)) continue;
    // Legacy rule-only outputs keep their permissive resume behavior. Old story
    // entries cannot establish which artifacts their episode-wide hash covered.
    fingerprints[key] = !entry.artifactStoryFingerprints && !entry.storyEnabled && !entry.analysis?.story
      ? storyFingerprintFor({ storyEnabled: false }) : null;
  }
  return fingerprints;
}

function staleStoryArtifacts(entry) {
  const fingerprints = artifactStoryFingerprints(entry);
  const current = entry?.storyFingerprint || storyFingerprintFor({ storyEnabled: false });
  return Object.fromEntries(ARTIFACT_KEYS.map((key) => [key, Boolean(entry?.[key] && fingerprints[key] !== current)]));
}

function episodePlanningStatus(entry) {
  const musicKeys = ['outputPath', 'finalVideoPath', 'timelinePath'];
  const outdated = Boolean(entry && (entry.analysisVersion || entry.analysis?.segments?.length) &&
    entry.analysisVersion !== PLANNING_VERSION);
  const accidental = outdated && !entry.storyEnabled && !entry.analysis?.story &&
    entry.analysis?.segments?.some((segment) =>
      !segment.track && !segment.explicitSilence && segment.mood === '中性留白');
  const pending = Array.isArray(entry?.pendingSilenceRepairs) ? entry.pendingSilenceRepairs : [];
  const repairArtifacts = musicKeys.filter((key) => entry?.[key] && (accidental || pending.includes(key)));
  const needsRegeneration = outdated || repairArtifacts.length > 0;
  return {
    needsRegeneration,
    repairArtifacts,
    regenerationReason: repairArtifacts.length
      ? '旧版留白产物：已选择的产物将在运行时重新生成；未选择的产物仍需更新。'
      : outdated ? '旧策略产物已保留；重新生成后应用新版选曲。' : '',
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function listTopLevelFiles(inputPath, extensions) {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) {
    if (!extensions.has(path.extname(inputPath).toLowerCase())) {
      throw new Error(`不支持的文件类型: ${inputPath}`);
    }
    return [normalizePath(inputPath)];
  }
  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputPath, entry.name))
    .sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
}

async function scanVideos(inputPath) {
  const files = await listTopLevelFiles(inputPath, VIDEO_EXTENSIONS);
  if (!files.length) throw new Error(`没有找到支持的视频文件: ${inputPath}`);
  return files;
}

async function scanMusic(musicDir) {
  const stat = await fs.stat(musicDir);
  if (!stat.isDirectory()) throw new Error('BGM 参数必须是目录: ' + musicDir);

  const groups = new Map();
  const knownMoods = [DEFAULT_MOOD, '抒情', ...MOOD_RULES.map((rule) => rule.mood)];
  async function visit(directory, mood) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const tracks = entries
      .filter((item) => item.isFile() && AUDIO_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
      .map((item) => path.join(directory, item.name));
    if (tracks.length) {
      const category = mood ?? DEFAULT_MOOD;
      if (!groups.has(category)) groups.set(category, []);
      const categoryTracks = groups.get(category);
      for (const track of tracks) categoryTracks.push(track);
    }
    for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
      // Album folders inherit their mood; explicit nested moods work below collection wrappers.
      const folder = new Map([[entry.name, []]]);
      const childMood = mood === null || knownMoods.some((name) => findMoodFolder(name, folder)) ? entry.name : mood;
      await visit(path.join(directory, entry.name), childMood);
    }
  }
  await visit(musicDir, null);

  for (const tracks of groups.values()) tracks.sort((a, b) =>
    naturalCompare(path.basename(a), path.basename(b)) || naturalCompare(path.relative(musicDir, a), path.relative(musicDir, b)) ||
    (a < b ? -1 : a > b ? 1 : 0));
  if (!groups.size) throw new Error('BGM 目录没有找到音频文件: ' + musicDir);
  return groups;
}
async function runProcess(command, args, { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(Object.assign(error, { command, args })));
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`${command} 退出码 ${code}: ${stderr.trim() || stdout.trim()}`);
      error.code = code;
      error.command = command;
      error.args = args;
      reject(error);
    });
  });
}

async function probeMedia(filePath, ffprobe, signal) {
  const { stdout } = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels,avg_frame_rate,r_frame_rate',
    '-of', 'json',
    filePath,
  ], { signal });
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe 返回了无效 JSON: ' + filePath);
  }
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取有效时长: ' + filePath);
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const frameRate = [video?.avg_frame_rate, video?.r_frame_rate].map((value) => {
    const [numerator, denominator = '1'] = String(value || '').split('/').map(Number);
    const rate = numerator / denominator;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }).find(Boolean) || null;
  return {
    duration,
    frameRate,
    streams,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
  };
}
async function inspectMusicCatalog(groups, ffprobe, ffmpeg, signal, state, allowEmpty = false) {
  const catalog = deduplicateMusic(groups);
  const files = catalog.files;
  const checked = new Map();
  let cursor = 0;
  let skipped = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const filePath = normalizePath(file);
      let entry;
      try {
        const stat = await fs.stat(file);
        const fingerprint = 'sample5s-v2:' + stat.size + ':' + stat.mtimeMs;
        entry = state.musicCatalog[filePath]?.fingerprint === fingerprint ? state.musicCatalog[filePath] : null;
        if (!entry) {
          entry = { fingerprint, playable: false, duration: null, reason: '' };
          try {
            const info = await probeMedia(file, ffprobe, signal);
            entry.duration = info.duration;
            if (info.hasAudio) {
              // shortcut: sample the middle five seconds for silence; use full-track analysis if quiet intros/outros need separate validation.
              const sampleDuration = Math.min(5, info.duration);
              const sampleStart = Math.max(0, (info.duration - sampleDuration) / 2);
              const { stderr } = await runProcess(ffmpeg, [
                '-hide_banner', '-nostats', '-ss', formatNumber(sampleStart), '-i', file,
                '-t', formatNumber(sampleDuration), '-af', 'volumedetect', '-f', 'null', '-',
              ], { signal });
              const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
              const peak = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
              entry.playable = Boolean(mean && peak && Number.isFinite(Number(mean[1])) && Number(mean[1]) > -70 && Number.isFinite(Number(peak[1])));
              entry.reason = entry.playable ? '' : '近似静音';
            } else {
              entry.reason = '没有音频流';
            }
          } catch (error) {
            if (signal?.aborted || error.code === 'ENOENT') throw error;
            entry.reason = '无法解码或读取';
          }
          state.musicCatalog[filePath] = entry;
        }
      } catch (error) {
        if (signal?.aborted || (error.code === 'ENOENT' && error.command)) throw error;
        entry = { playable: false, duration: null, reason: '文件无法读取' };
      }
      checked.set(file, entry);
      if (!entry.playable) skipped += 1;
    }
  }));
  const usableGroups = new Map([...catalog.groups].flatMap(([mood, tracks]) => {
    const usable = tracks.filter((file) => checked.get(file)?.playable);
    return usable.length ? [[mood, usable]] : [];
  }));
  if (!usableGroups.size && !allowEmpty) throw new Error('背景音乐目录中没有可用的非静音音轨，已检查 ' + files.length + ' 首并跳过 ' + skipped + ' 首');
  return { groups: usableGroups, checked: files.length, skipped, duplicates: catalog.duplicates, files: [...checked].map(([file, entry]) => ({ file, ...entry })) };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function freezeTailDuration(value, frameRate) {
  const match = /^(\d+):(\d+)$/.exec(String(value || '0:00').trim());
  if (!match) throw new Error('片尾定格时长格式应为 秒:帧，例如 2:15');
  const seconds = Number(match[1]);
  const frames = Number(match[2]);
  if (!frames) return seconds;
  if (!frameRate) throw new Error('视频帧率不可读，无法按帧设置片尾定格时长');
  if (frames >= Math.ceil(frameRate)) throw new Error(`片尾帧数必须小于视频帧率（约 ${Math.ceil(frameRate)} 帧/秒）`);
  return seconds + frames / frameRate;
}

function normalizeTranscript(raw, duration) {
  const source = Array.isArray(raw) ? raw : raw?.segments;
  if (!Array.isArray(source)) throw new Error('字幕 JSON 必须是数组，或包含 segments 数组');
  return source
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: String(segment.text || '').trim(),
      words: Array.isArray(segment.words) ? segment.words : undefined,
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .map((segment) => {
      const normalized = { start: clamp(segment.start, 0, duration), end: clamp(segment.end, 0, duration), text: segment.text };
      const words = segment.words?.map((word) => ({ start: Number(word.start), end: Number(word.end), word: String(word.word ?? word.text ?? ''),
        ...(Number.isFinite(word.probability) ? { probability: word.probability } : {}) }));
      if (words?.length && words.every((word, index) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start && word.start >= normalized.start && word.end <= normalized.end && (!index || word.start >= words[index - 1].start))) normalized.words = words;
      return normalized;
    })
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
}

async function findTranscript(videoPath, transcriptDir, duration) {
  if (!transcriptDir) return null;
  const stem = path.parse(videoPath).name;
  const candidates = [
    path.join(transcriptDir, `${stem}.json`),
    path.join(transcriptDir, `${stem}.transcript.json`),
    path.join(transcriptDir, `${stem}_transcript.json`),
  ];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    const raw = JSON.parse(await fs.readFile(candidate, 'utf8'));
    return { path: candidate, segments: normalizeTranscript(raw, duration), source: raw.provider || raw.source || 'sidecar', language: raw.language, languageProbability: raw.language_probability };
  }
  return null;
}

async function runTranscriber(videoPath, outputPath, options) {
  const venvPython = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  const python = process.env.PYTHON || (await pathExists(venvPython) ? venvPython : 'python');
  const script = options.transcriberScript || path.resolve(__dirname, '..', 'tools', 'transcribe.py');
  if (options.transcriberExecutable && !(await pathExists(options.transcriberExecutable))) {
    throw new Error(`内置转录组件不存在：${options.transcriberExecutable}`);
  }
  const model = options.modelPath || process.env.FASTER_WHISPER_MODEL || 'small';
  const language = options.language || process.env.FASTER_WHISPER_LANGUAGE || 'auto';
  const args = ['--input', videoPath, '--output', outputPath, '--model', model, '--language', language, '--device', 'cpu', '--compute-type', 'int8'];
  await runProcess(options.transcriberExecutable || python, options.transcriberExecutable ? args : [script, ...args], { signal: options.signal });
  const raw = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  const probe = await probeMedia(videoPath, options.ffprobe, options.signal);
  return { path: outputPath, segments: normalizeTranscript(raw, probe.duration), source: raw.provider || 'sidecar', language: raw.language, languageProbability: raw.language_probability };
}

function mergeIntervals(segments, duration, padding = 0.12) {
  const intervals = segments
    .map((segment) => ({ start: clamp(segment.start - padding, 0, duration), end: clamp(segment.end + padding, 0, duration) }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

const NEGATION_PATTERN = /(?:(?:不|没|未|别|无|不是|从不|从没)(?:再|会|想|要|觉得|那么|很|真的|感到|是|有){0,3}|(?:\bnever|\bnot|\bno|n't)(?:\s+[a-z]+){0,3})\s*$/i;
const WEAK_ENGLISH_CUES = new Set(['mom', 'mother', 'dad', 'father', 'family', 'wife', 'husband', 'love', 'loves', 'wedding', 'marry', 'married', 'happy', 'sad', 'sorry', 'thank', 'thanks', 'care', 'home', 'careful', 'danger', 'fight', 'fighting', 'monitor', 'follow', 'finally', 'hope', 'support', '爱', '喜欢', '婚礼', '妈妈', '爸爸', '家人', '小心']);
MOOD_RULES.find((rule) => rule.mood === '浪漫').words.push('我爱你', '我们一直相爱', '我们结婚吧', 'i love my husband', 'i love my wife');
MOOD_RULES.find((rule) => rule.mood === '愤怒').words.push('back off', 'made enough of a scene', 'take her side', 'take his side', "don't even trust me", 'stop going after', 'are you tracking me', 'stop making a scene', 'force an answer', 'spread lies');
WEAK_ENGLISH_CUES.add("i'm scared");
WEAK_ENGLISH_CUES.add("i'm afraid");
WEAK_ENGLISH_CUES.add('leave');
WEAK_ENGLISH_CUES.add('left');

function moodWordHits(text, rule) {
  const searchableText = String(text || '').toLowerCase().replace(/[’‘]/g, "'");
  return rule.words.filter((word) => {
    const keyword = word.toLowerCase();
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+');
    const pattern = new RegExp(/^[a-z]/.test(keyword) ? `\\b${escaped}\\b` : escaped, 'g');
    return [...searchableText.matchAll(pattern)].some((match) => {
      const prefix = searchableText.slice(Math.max(0, match.index - 48), match.index).split(/[.,!?;。！？；，\n]/).at(-1);
      return !NEGATION_PATTERN.test(prefix);
    });
  });
}

function moodCandidates(text, groups) {
  return MOOD_RULES.map((rule) => {
    const hits = moodWordHits(text, rule);
    const usableHits = hits.filter((hit) => !WEAK_ENGLISH_CUES.has(hit));
    const phraseHits = usableHits.filter((hit) => hit.length >= 3 || hit.includes(' ')).length;
    return { mood: findMoodFolder(rule.mood, groups) || rule.mood, hits: usableHits, score: usableHits.length + phraseHits * 0.25 };
  }).filter((result) => result.mood && result.score > 0).sort((a, b) => b.score - a.score || b.hits.length - a.hits.length);
}

function inferMood(transcript, groups, override) {
  if (override) {
    const folder = findMoodFolder(override, groups) || canonicalMood(override);
    if (!folder) throw new Error(`找不到指定情绪目录“${override}”，已有目录: ${[...groups.keys()].join(', ')}`);
    return { mood: folder, reason: `人工覆盖: ${override}` };
  }

  const text = (transcript?.segments || []).map((segment) => segment.text).join(' ');
  const hits = moodCandidates(text, groups);
  if (hits.length) return { mood: hits[0].mood, reason: `对白情绪线索: ${hits[0].hits.join('、')}` };
  const fallback = findMoodFolder(DEFAULT_MOOD, groups);
  return { mood: fallback, review: true, reason: fallback ? '情绪证据不足，使用中性回退，待试听' : '情绪证据不足且无中性曲目，使用曲库中较克制的候选，待试听' };
}


function classifyMoodText(text, groups) {
  const result = moodCandidates(text, groups)[0];
  if (result) return { mood: result.mood, hits: result.hits };
  return { mood: null, hits: [] };
}

function splitTranscriptSegment(segment) {
  if (!segment.words?.length) return [{ ...segment, timingSource: 'segment' }];
  const clauses = [];
  let words = [];
  const flush = () => {
    if (words.length) clauses.push({ start: words[0].start, end: words.at(-1).end, text: words.map((word) => word.word).join('').trim(), words, timingSource: 'word' });
    words = [];
  };
  for (const word of segment.words) {
    if (/^(?:but|however|yet|though|although|instead)\b|^(?:但是|可是|不过|然而)/i.test(word.word.trim())) flush();
    words.push(word);
    if (/[。！？!?；;.]\s*$/.test(word.word)) flush();
  }
  flush();
  return clauses;
}

function pickSectionMood(moodRuns, start, end, fallbackMood) {
  const scores = new Map();
  for (const run of moodRuns) {
    const overlap = Math.max(0, Math.min(end, run.end) - Math.max(start, run.start));
    if (!overlap) continue;
    const score = (run.hitCount || run.segmentCount) * (1 + overlap);
    scores.set(run.mood, (scores.get(run.mood) || 0) + score);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallbackMood;
}

const MIN_MOOD_RUN_SECONDS = 3;
const MIN_MOOD_RUN_HITS = 2;

function collectMoodRuns(classified) {
  const runs = [];
  for (const item of classified.filter((segment) => segment.mood).sort((a, b) => a.start - b.start)) {
    const current = runs.at(-1);
    if (current?.mood === item.mood && item.start - current.end <= 12) {
      current.end = Math.max(current.end, item.end);
      current.hitCount += item.hits.length;
      current.segmentCount += 1;
      current.evidenceSeconds += Math.max(0, item.end - item.start);
    } else {
      runs.push({ mood: item.mood, start: item.start, end: item.end, hitCount: item.hits.length, segmentCount: 1, evidenceSeconds: item.end - item.start });
    }
  }

  const stableRuns = runs.filter((run) => run.evidenceSeconds >= MIN_MOOD_RUN_SECONDS && (run.segmentCount >= 2 || run.hitCount >= MIN_MOOD_RUN_HITS || run.evidenceSeconds >= 6));
  return stableRuns.reduce((merged, run) => {
    const previous = merged.at(-1);
    if (previous?.mood === run.mood) {
      previous.end = Math.max(previous.end, run.end);
      previous.hitCount += run.hitCount;
      previous.segmentCount += run.segmentCount;
    } else {
      merged.push({ ...run });
    }
    return merged;
  }, []);
}

function sectionReason(classified, start, end, options) {
  const words = [...new Set(classified
    .filter((item) => Math.min(end, item.end) > Math.max(start, item.start))
    .flatMap((item) => item.hits))].slice(0, 4);
  if (words.length) return '片段对白关键词: ' + words.join('、');
  if (options.mood) return '人工覆盖: ' + options.mood;
  return '未检测到明确情绪关键词，使用默认情绪';
}

function buildMusicPlan(context) {
  maxTrackDuration(context.options);
  return enforceTrackDuration(buildUnboundedMusicPlan(context), context);
}

function buildUnboundedMusicPlan(context) {
  const { duration, transcript, groups, options, trackUses, sceneCuts = [] } = context;
  if (options.localVisionEnabled) return buildLocalVisionMusicPlan(context, context.localVisionPlan, chooseTrack);
  if (options.storyEnabled) return buildStoryMusicPlan({ ...context, planningVersion: PLANNING_VERSION }, chooseTrack);
  const scenePriority = options.scenePriority !== false;
  const requestedSegmentLimit = Number(options.maxTracksPerEpisode ?? 3);
  const configuredSegmentLimit = Number.isSafeInteger(requestedSegmentLimit) && requestedSegmentLimit >= 0 ? requestedSegmentLimit : 3;
  const requestedMinimum = Number(options.minTracksPerEpisode ?? 1);
  if (!Number.isSafeInteger(requestedMinimum) || requestedMinimum < 1 || !scenePriority && configuredSegmentLimit && requestedMinimum > configuredSegmentLimit) throw new Error('每集 BGM 下限必须为正整数，且不能高于生效的上限');
  const maxSegments = scenePriority ? Infinity : configuredSegmentLimit || Infinity;
  let minimumTarget = Math.min(requestedMinimum, Math.max(1, Math.floor(duration / 6)));
  const episodeTracks = new Set();
  const baseMood = inferMood(transcript, groups, options.mood);
  const rawSegments = transcript?.segments || [];
  const classified = rawSegments.flatMap(splitTranscriptSegment).map((segment) => options.mood
    ? { ...segment, mood: baseMood.mood, hits: [] }
    : { ...segment, ...classifyMoodText(segment.text, groups) });
  const moodRuns = collectMoodRuns(classified);
  const candidates = [];
  for (let index = 1; index < moodRuns.length; index += 1) {
    const previous = moodRuns[index - 1];
    const current = moodRuns[index];
    if (previous.mood === current.mood) continue;
    const previousFolder = findCompatibleMoodFolder(previous.mood, groups);
    const compatibleContinuation = Boolean(previousFolder && previousFolder === findCompatibleMoodFolder(current.mood, groups));
    const gapStart = Math.min(previous.end, current.start);
    const gapEnd = current.start;
    const scene = sceneCuts.filter((cut) => cut.time >= gapStart - 0.2 && cut.time <= gapEnd + 0.2 && (!scenePriority || Math.abs(cut.time - current.start) <= 1.5))
      .sort((a, b) => Math.abs(a.time - current.start) - Math.abs(b.time - current.start))[0];
    const pause = gapEnd - gapStart >= 0.3;
    candidates.push({
      boundary: clamp(scene?.time ?? (pause ? gapEnd - Math.min(0.2, (gapEnd - gapStart) / 2) : current.start), 0, duration),
      window: [gapStart, gapEnd], sceneTime: scene?.time,
      nextMood: current.mood,
      compatibleContinuation,
      reason: scene ? '持续对白情绪转折与镜头候选重合' : pause ? '持续对白情绪转折，落在对白停顿' : '持续对白情绪转折，落在句段边界',
      score: previous.hitCount + current.hitCount + Math.min(current.end - current.start, 30) / 30,
    });
  }
  // shortcut: visual scores cannot understand locations; replace with scene semantics when false cuts matter.
  if (scenePriority) for (const cut of sceneCuts) {
    if (cut.score < 30 && cut.kind !== 'black') continue;
    candidates.push({ boundary: cut.time, sceneTime: cut.time, sceneChange: true, changeTrack: true,
      reason: '转场必换曲：检测到场景变化，即使情绪相同也更换曲目，待试听', score: cut.score / 10 });
  }
  if (!options.mood) for (let index = 1; index < rawSegments.length; index += 1) {
    const pauseStart = rawSegments[index - 1].end;
    const pauseEnd = rawSegments[index].start;
    if (pauseEnd - pauseStart < 2.5) continue;
    const scene = sceneCuts.filter((cut) => cut.time >= pauseStart && cut.time <= pauseEnd + 0.2)
      .sort((a, b) => Math.abs(a.time - pauseEnd) - Math.abs(b.time - pauseEnd))[0];
    if (!scene || !moodRuns.some((run) => run.end <= pauseEnd && pauseEnd - run.end <= 12)) continue;
    if (moodRuns.some((run) => run.start < pauseEnd && run.end > pauseEnd)) continue;
    candidates.push({ boundary: scene.time, window: [pauseStart, pauseEnd], sceneTime: scene.time,
      neutralReset: true, reason: '镜头变化与较长对白停顿重合，结束前段情绪并保守回退，待试听', score: 2 });
  }
  const minimumSegmentDuration = Math.min(12, duration);
  const boundaries = [];
  const canSplit = (time, spacing, allowShortTail = true) => {
    const points = [0, ...boundaries.map((item) => item.boundary), duration].sort((a, b) => a - b);
    const index = points.findIndex((end) => end > time);
    if (index < 1 || time - points[index - 1] < spacing || points[index] - time < (allowShortTail && index === points.length - 1 ? Math.min(6, spacing) : spacing)) return false;
    const split = [...points, time].sort((a, b) => a - b);
    return split.slice(1).reduce((sum, end, i) => sum + Math.max(1, Math.floor((end - split[i] + 0.000001) / 6)), 0) >= minimumTarget;
  };
  if (scenePriority) {
    for (const candidate of candidates.sort((a, b) => a.boundary - b.boundary)) {
      if (candidate.boundary <= 0 || candidate.boundary >= duration) continue;
      const existing = boundaries.find((item) => Math.abs(item.boundary - candidate.boundary) < 0.25);
      if (existing) {
        if (candidate.sceneChange) Object.assign(existing, { boundary: candidate.boundary, sceneTime: candidate.sceneTime, sceneChange: true, required: true, changeTrack: true });
        existing.nextMood ||= candidate.nextMood;
        existing.neutralReset ||= candidate.neutralReset;
        existing.reason = [...new Set([existing.reason, candidate.reason])].join('；');
      } else boundaries.push({ ...candidate, required: !candidate.compatibleContinuation, changeTrack: !candidate.compatibleContinuation });
    }
  } else for (const candidate of candidates.sort((a, b) => b.score - a.score || a.boundary - b.boundary)) {
    if (boundaries.length >= maxSegments - 1) break;
    if (canSplit(candidate.boundary, minimumSegmentDuration)) boundaries.push(candidate);
  }
  const requiredPoints = [0, ...boundaries.map((item) => item.boundary), duration].sort((a, b) => a - b);
  minimumTarget = Math.min(requestedMinimum, requiredPoints.slice(1).reduce((sum, end, index) =>
    sum + Math.max(1, Math.floor((end - requiredPoints[index] + 0.000001) / 6)), 0));
  const minimumCandidates = sceneCuts.map((cut) => ({ boundary: cut.time, sceneTime: cut.time, score: cut.score,
    changeTrack: true, reason: '满足每集 BGM 下限，优先在镜头变化处换曲，待试听' }));
  for (let index = 1; index < rawSegments.length; index += 1) {
    const start = rawSegments[index - 1].end;
    const end = rawSegments[index].start;
    if (end - start >= 0.3) minimumCandidates.push({ boundary: (start + end) / 2, score: end - start,
      changeTrack: true, reason: '满足每集 BGM 下限，在对白停顿处换曲，待试听' });
  }
  minimumCandidates.sort((a, b) => Number(Boolean(b.sceneTime)) - Number(Boolean(a.sceneTime)) || b.score - a.score);
  for (const spacing of [12, 6]) for (const candidate of minimumCandidates) {
    if (boundaries.length >= minimumTarget - 1) break;
    if (canSplit(candidate.boundary, spacing, false)) boundaries.push(candidate);
  }
  while (boundaries.length < minimumTarget - 1) {
    const points = [0, ...boundaries.map((item) => item.boundary), duration].sort((a, b) => a - b);
    const [start, end] = points.slice(1).map((end, index) => [points[index], end]).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    const capacity = Math.floor((end - start + 0.000001) / 6);
    if (capacity < 2) break;
    boundaries.push({ boundary: start + (end - start) * Math.floor(capacity / 2) / capacity, changeTrack: true,
      reason: '满足每集 BGM 下限：无合适转场或停顿，按可用时长补足换曲，待试听' });
  }
  boundaries.sort((a, b) => a.boundary - b.boundary);
  for (const boundary of boundaries.slice(0, minimumTarget - 1)) boundary.changeTrack = true;
  const points = [0, ...boundaries.map((item) => item.boundary), duration];
  const ranges = points.slice(1).map((end, index) => [points[index], end]);
  const fallbackMood = options.mood ? baseMood.mood : findMoodFolder(DEFAULT_MOOD, groups);
  const sections = [];
  for (const [start, end] of ranges) {
    const previous = sections.at(-1);
    const transition = boundaries.find((item) => Math.abs(item.boundary - start) < 0.001);
    const reset = transition?.neutralReset || transition?.sceneChange;
    const mood = scenePriority && transition?.nextMood || pickSectionMood(moodRuns, start, end, reset ? fallbackMood : previous?.mood || fallbackMood);
    if (previous && previous.mood === mood && !transition?.changeTrack) { previous.end = end; continue; }
    sections.push({ start, end, mood, transition });
  }
  const segments = [];
  for (const section of sections) {
    const { start, end, transition } = section;
    const previous = segments.at(-1);
    const reset = transition?.neutralReset || transition?.sceneChange;
    const mood = section.mood || (!reset ? previous?.selectedMood : null) || null;
    const track = chooseTrack(groups, mood, trackUses, episodeTracks, options.trackMetadata, transition?.changeTrack || episodeTracks.size < requestedMinimum, transition?.required ? previous?.track : null);
    if (transition?.required && (!track || track === previous?.track)) throw new Error(`${formatNumber(start)} 秒处必须换曲，但没有另一首匹配情绪、相近风格或兼容中性的合格曲目；请补充或确认曲目后重试。`);
    if (!track) throw new Error(`${formatNumber(start)} 秒处目标情绪“${mood || '未明确'}”没有匹配、相近风格或兼容中性的合格曲目；请补充或确认曲库后重试。`);
    const metadata = options.trackMetadata?.get(track);
    const selection = describeTrackSelection(groups, mood, track);
    if (!section.mood) Object.assign(selection, { requestedMood: null, matchType: 'library' });
    const compatibleFallback = selection.matchType !== 'exact';
    const evidence = moodRuns.filter((run) => Math.min(run.end, end) > Math.max(run.start, start));
    const review = Boolean(transition?.changeTrack) || !evidence.length || end - Math.max(...evidence.map((run) => run.end)) > 12 || compatibleFallback || !track;
    const reason = [start > 0 ? boundaries.find((item) => Math.abs(item.boundary - start) < 0.001)?.reason : '',
      sectionReason(classified, start, end, options), selectionReason(selection),
      review ? '规则证据不足或使用替代曲目，待试听' : ''].filter(Boolean).join('；');
    if (previous && previous.track === track && previous.requestedMood === selection.requestedMood) { previous.end = end; previous.reason += '；后续相近需求继续原曲'; previous.review ||= review; continue; }
    if (track) { episodeTracks.add(track); trackUses.set(track, (trackUses.get(track) || 0) + 1); }
    segments.push({ start, end, mood: mood || selection.selectedMood, track, reason, review, ...selection,
      continueTrack: Boolean(previous && previous.track === track),
      cueIn: metadata?.cueIn || 0, intensity: metadata?.intensity || null,
      instrumentalStatus: metadata?.status || (track ? 'unknown' : 'silence'),
      vocalEvidence: metadata?.analysis?.intervals || [],
      transition: boundaries.find((item) => Math.abs(item.boundary - start) < 0.001) || null,
      timingSource: classified.some((item) => item.timingSource === 'word') ? 'word' : 'segment',
    });
  }
  const sceneCandidates = sceneCuts.map((cut) => {
    const segment = segments.find((item) => item.start > 0 && Math.abs(item.start - cut.time) < 0.25);
    return { ...cut, required: scenePriority && (cut.score >= 30 || cut.kind === 'black'), used: Boolean(segment), reason: segment?.transition?.reason || '普通镜头候选或转场必换已关闭；未触发情绪换曲或数量补足' };
  });
  if (sceneCandidates.some((cut) => cut.required && !cut.used)) throw new Error('检测到转场却未能更换曲目，请检查转场计划后重试');
  const actualTracks = new Set(segments.map((segment) => segment.track).filter(Boolean)).size;
  const trackCount = { minimum: requestedMinimum, actual: actualTracks, segments: segments.length, met: actualTracks >= requestedMinimum };
  trackCount.warning = trackCount.met ? '' : `未达到每集至少 ${requestedMinimum} 首：实际 ${actualTracks} 首；${minimumTarget < requestedMinimum ? '有效配乐时长不足或受必换点分段限制，补足片段至少保留 6 秒' : '当前情绪、相近风格及兼容中性曲目不足，不使用不匹配或未通过筛选的曲目补数'}。`;
  return { baseMood, segments, sceneCandidates, trackCount, planningVersion: PLANNING_VERSION };
}

function parseSceneCandidates(stderr, duration) {
  const cuts = [...stderr.matchAll(/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g)]
    .map((match) => ({ time: Number(match[2]), score: Number(match[1]), kind: 'cut' }));
  for (const match of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    if (Number(match[3]) >= 0.12) cuts.push({ time: Number(match[2]), score: 100, kind: 'black' });
  }
  const filtered = [];
  for (const cut of cuts.filter((item) => item.time >= 0.5 && item.time <= duration - 0.5).sort((a, b) => a.time - b.time)) {
    const previous = filtered.at(-1);
    if (previous && cut.time - previous.time < 1) { previous.score = Math.max(previous.score, cut.score); if (cut.kind === 'black') previous.kind = 'black'; }
    else filtered.push(cut);
  }
  return filtered;
}

async function detectSceneCandidates(videoPath, duration, options) {
  const { stderr } = await runProcess(options.ffmpeg, ['-hide_banner', '-nostats', '-i', videoPath, '-an', '-vf', 'scale=248:-2,scdet=threshold=10,blackdetect=d=0.12:pix_th=0.10', '-f', 'null', '-'], { signal: options.signal });
  return parseSceneCandidates(stderr, duration);
}

function clipIntervals(intervals, start, end) {
  return intervals
    .map((interval) => ({ start: Math.max(start, interval.start), end: Math.min(end, interval.end) }))
    .filter((interval) => interval.end > interval.start);
}

function buildDuckExpression(intervals, duckDb) {
  const duckVolume = formatNumber(Math.pow(10, duckDb / 20));
  return intervals.reduceRight((next, interval) => {
    const start = formatNumber(interval.start);
    const end = formatNumber(interval.end);
    const fade = Math.min(0.12, Math.max(0.001, (interval.end - interval.start) / 2));
    const downEnd = Math.min(interval.end, interval.start + fade);
    const upStart = Math.max(interval.start, interval.end - fade);
    const current = 'if(lt(t,' + formatNumber(downEnd) + '),1-(1-' + duckVolume + ')*(t-' + start + ')/' + formatNumber(fade) +
      ',if(lt(t,' + formatNumber(upStart) + '),' + duckVolume +
      ',if(lt(t,' + end + '),' + duckVolume + '+(1-' + duckVolume + ')*(t-' + formatNumber(upStart) + ')/' + formatNumber(fade) + ',1)))';
    return 'if(between(t,' + start + ',' + end + '),' + current + ',' + next + ')';
  }, '1');
}

function buildMultiTrackFilter(segments, duration, options, intervals, hasDialogue = true) {
  // Keep intent segments in artifacts, but render an unchanged track continuously.
  segments = playbackWindows(segments, duration, options);
  const graph = [];
  segments.forEach((segment, index) => {
    const { renderStart, renderEnd, fadeIn, fadeOut } = segment;
    const renderDuration = renderEnd - renderStart;
    const startSample = Math.ceil(renderStart * 48000 - 1e-7);
    const endSample = Math.floor(renderEnd * 48000 + 1e-7);
    const sampleCount = endSample - startSample;
    if (sampleCount < 1) throw new Error('单曲时长或配乐片段短于一个音频采样点，请增大单曲连续播放时长后重试。');
    const localIntervals = clipIntervals(intervals, renderStart, renderEnd)
      .map((interval) => ({ start: interval.start - renderStart, end: interval.end - renderStart }));
    const filters = [
      'atrim=start=' + Number(segment.cueIn || 0).toFixed(9) + ':duration=' + ((sampleCount + 1) / 48000).toFixed(9),
      'asetpts=PTS-STARTPTS',
      'aresample=48000',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    ];
    if (!segment.explicitSilence) filters.push('loudnorm=I=' + (hasDialogue ? -28 : -18) + ':TP=-1.5:LRA=11:print_format=none');
    filters.push('aresample=48000');
    filters.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
    // Loudness/resampling may extend short inputs; the cap includes that tail.
    filters.push('atrim=end_sample=' + sampleCount);
    filters.push('asetnsamples=n=480:p=0');
    filters.push('asetpts=N/SR/TB');
    if (options.autoDuck && localIntervals.length && options.duckDb < 0) {
      filters.push("volume=volume='" + buildDuckExpression(localIntervals, options.duckDb) + "':eval=frame");
    }
    if (fadeIn > 0) filters.push('afade=t=in:st=0:d=' + formatNumber(fadeIn));
    if (fadeOut > 0) filters.push('afade=t=out:st=' + formatNumber(Math.max(0, renderDuration - fadeOut)) + ':d=' + formatNumber(fadeOut));
    if (startSample > 0) filters.push('adelay=' + (startSample % 48 === 0 ? startSample / 48 : startSample + 'S') + ':all=1');
    graph.push('[' + segment.inputIndex + ':a]' + filters.join(',') + '[seg' + index + ']');
  });
  const silenceRanges = segments.filter((segment) => segment.explicitSilence);
  const silenceCondition = silenceRanges.map((segment) => `gte(t,${segment.start})*lt(t,${segment.end})`).join('+');
  // Gate after resampling and limiting so sub-millisecond ASR boundaries stay silent.
  const silenceGate = silenceRanges.length
    ? ",aeval=exprs='if(" + silenceCondition + ",0,val(0))|if(" + silenceCondition + ",0,val(1))':channel_layout=stereo"
    : '';
  graph.push(segments.map((_, index) => '[seg' + index + ']').join('') +
    'amix=inputs=' + segments.length + ':duration=longest:dropout_transition=0:normalize=0,' +
    'atrim=start=0:duration=' + formatNumber(duration) + ',asetpts=PTS-STARTPTS,alimiter=limit=0.891:level=0:latency=1,' +
    'aresample=48000,asetpts=N/SR/TB' + silenceGate + '[aout]');
  return graph.join(';');
}

function formatNumber(value) {
  return Number(value.toFixed(3)).toString();
}

function buildAudioFilter(duration, options, intervals) {
  const filters = [];
  const fadeIn = clamp(Number(options.fadeIn) || 0, 0, duration);
  const fadeOut = clamp(Number(options.fadeOut) || 0, 0, duration);
  if (fadeIn > 0) filters.push('afade=t=in:st=0:d=' + formatNumber(fadeIn));
  if (fadeOut > 0) filters.push('afade=t=out:st=' + formatNumber(Math.max(0, duration - fadeOut)) + ':d=' + formatNumber(fadeOut));
  if (options.autoDuck && intervals.length && options.duckDb < 0) {
    const duckVolume = formatNumber(Math.pow(10, options.duckDb / 20));
    const expressions = intervals.map(({ start, end }) => {
      const fade = Math.min(0.12, Math.max(0.001, (end - start) / 2));
      const downEnd = Math.min(end, start + fade);
      const upStart = Math.max(start, end - fade);
      return 'if(lt(t,' + formatNumber(downEnd) + '),1-(1-' + duckVolume + ')*(t-' + formatNumber(start) + ')/' + formatNumber(fade) +
        ',if(lt(t,' + formatNumber(upStart) + '),' + duckVolume +
        ',if(lt(t,' + formatNumber(end) + '),' + duckVolume + '+(1-' + duckVolume + ')*(t-' + formatNumber(upStart) + ')/' + formatNumber(fade) + ',1)))';
    });
    const expression = expressions.reduceRight((next, current, index) =>
      'if(between(t,' + formatNumber(intervals[index].start) + ',' + formatNumber(intervals[index].end) + '),' + current + ',' + next + ')', '1');
    filters.push("volume=volume='" + expression + "':eval=frame");
  }
  filters.push('alimiter=limit=0.891:level=0:latency=1');
  return filters.join(',');
}
function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function timelineCsv({ episode, segments, options, intervals, freezeTailSeconds, trackCount }) {
  const spans = playbackWindows(segments, segments.at(-1).end, options);
  const spanAt = (index) => spans.findLast((span) => span.inputIndex <= index);
  const headers = ['episode', 'segment', 'start_sec', 'end_sec', 'bgm_file', 'mood', 'selection_reason', 'fade_in_sec', 'fade_out_sec', 'duck_db', 'duck_segments', 'freeze_tail', 'freeze_tail_sec', 'analysis_version', 'instrumental_status', 'cue_in_sec', 'intensity', 'needs_review', 'timing_source', 'transition_evidence', 'duck_attack_sec', 'duck_release_sec', 'music_loudness_lufs', 'vocal_evidence', 'scene_priority', 'minimum_tracks', 'actual_tracks', 'minimum_met', 'max_track_duration_sec', 'render_start_sec', 'render_end_sec'];
  const rows = segments.map((segment, index) => [
    episode,
    index + 1,
    formatNumber(segment.start),
    formatNumber(segment.end),
    segment.track ? path.relative(options.music, segment.track) : '',
    segment.mood,
    segment.reason,
    formatNumber(spanAt(index).inputIndex === index ? spanAt(index).fadeIn : 0),
    formatNumber(index === segments.length - 1 || spanAt(index + 1) !== spanAt(index) ? spanAt(index).fadeOut : 0),
    formatNumber(options.autoDuck && segment.track && options.duckDb < 0 && clipIntervals(intervals, segment.start, segment.end).length ? options.duckDb : 0),
    JSON.stringify(options.autoDuck && segment.track && options.duckDb < 0 ? clipIntervals(intervals, segment.start, segment.end).map((interval) => ({
      start: Number(formatNumber(interval.start)),
      end: Number(formatNumber(interval.end)),
    })) : []),
    options.freezeTail || '0:00',
    formatNumber(freezeTailSeconds),
    PLANNING_VERSION,
    segment.instrumentalStatus,
    formatNumber(segment.cueIn || 0),
    segment.intensity || '',
    Boolean(segment.review),
    segment.timingSource,
    JSON.stringify(segment.transition),
    options.autoDuck && segment.track && options.duckDb < 0 && clipIntervals(intervals, segment.start, segment.end).length ? 0.12 : 0,
    options.autoDuck && segment.track && options.duckDb < 0 && clipIntervals(intervals, segment.start, segment.end).length ? 0.12 : 0,
    options.hasOriginalAudio ? -28 : -18,
    JSON.stringify(segment.vocalEvidence || []),
    options.scenePriority !== false,
    trackCount.minimum,
    trackCount.actual,
    trackCount.met,
    maxTrackDuration(options),
    formatNumber(spanAt(index).renderStart),
    formatNumber(spanAt(index).renderEnd),
  ]);
  return [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

async function readState(statePath) {
  if (!(await pathExists(statePath))) return { version: STATE_VERSION, episodes: {}, trackUses: {}, musicCatalog: {} };
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return {
      version: STATE_VERSION,
      episodes: state.episodes && typeof state.episodes === 'object' ? state.episodes : {},
      trackUses: state.trackUses && typeof state.trackUses === 'object' ? state.trackUses : {},
      musicCatalog: state.musicCatalog && typeof state.musicCatalog === 'object' ? state.musicCatalog : {},
    };
  } catch {
    throw new Error(`状态文件损坏，请备份后删除再重跑: ${statePath}`);
  }
}

async function writeState(statePath, state) {
  const tempPath = `${statePath}.part`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, statePath);
}

function finalAudioFormat(videoPath) {
  const extension = path.extname(videoPath).toLowerCase();
  if (extension === '.webm') return ['libopus', '128k'];
  if (extension === '.avi') return ['libmp3lame', '192k'];
  return ['aac', '192k'];
}

function buildFinalMixFilter(hasOriginalAudio) {
  const stereo = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const limiter = 'alimiter=limit=0.891:level=0:latency=1';
  if (!hasOriginalAudio) return '[1:a:0]' + stereo + ',' + limiter + '[aout]';
  return '[0:a:0]' + stereo + '[dialogue];[1:a:0]' + stereo + '[bgm];' +
    '[dialogue][bgm]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,' + limiter + '[aout]';
}

async function renderFinalVideo(videoPath, bgmPath, outputPath, probe, options) {
  const extension = path.extname(videoPath).toLowerCase();
  const [audioCodec, audioBitrate] = finalAudioFormat(videoPath);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-i', bgmPath,
    '-filter_complex', buildFinalMixFilter(probe.hasAudio), '-map', '0:v:0', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', audioCodec, '-b:a', audioBitrate, '-ar', '48000', '-ac', '2',
    '-t', formatNumber(probe.duration)];
  if (['.mp4', '.m4v', '.mov'].includes(extension)) args.push('-movflags', '+faststart');
  args.push(outputPath);
  await runProcess(options.ffmpeg, args, { signal: options.signal });
}

async function finalVideoIsValid(outputPath, duration, ffprobe, ffmpeg, signal) {
  if (!(await pathExists(outputPath))) return false;
  try {
    const info = await probeMedia(outputPath, ffprobe, signal);
    if (!info.hasVideo || !info.hasAudio || Math.abs(info.duration - duration) > 0.2) return false;
    await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', outputPath, '-f', 'null', '-'], { signal });
    return true;
  } catch {
    return false;
  }
}

async function outputIsValid(outputPath, duration, ffprobe, ffmpeg, signal, allowSilence = false) {
  if (!(await pathExists(outputPath))) return false;
  try {
    const info = await probeMedia(outputPath, ffprobe, signal);
    const audio = info.streams.find((stream) => stream.codec_type === 'audio');
    if (!audio || audio.codec_name !== 'pcm_s16le' || Number(audio.sample_rate) !== 48000 || Number(audio.channels) !== 2 || Math.abs(info.duration - duration) > 0.05) return false;
    const { stderr } = await runProcess(ffmpeg, ['-hide_banner', '-nostats', '-i', outputPath, '-af', 'volumedetect', '-f', 'null', '-'], { signal });
    const peak = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    // shortcut: treat mean levels at or below -70 dB as silence; if ultra-quiet BGM is supported, make this configurable.
    return Boolean(peak && mean && Number.isFinite(Number(peak[1])) && Number.isFinite(Number(mean[1])) && Number(peak[1]) <= -0.9 && (allowSilence || Number(mean[1]) > -70));
  } catch {
    return false;
  }
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function renderEpisode({ videoPath, outputDir, groups, state, options, catalogSignature, libraryUnavailableReason, storyInput, onProcessing, onStage, onRepair, onVisionProgress }) {
  const episode = path.parse(videoPath).name;
  const {
    outputPath, timelinePath, finalVideoPath, asrTranscriptPath,
    tempOutputPath, tempTimelinePath, tempFinalVideoPath, tempTranscriptPath, tempTranscriptOutputPath,
  } = episodeArtifacts(videoPath, outputDir);
  const stateKey = normalizePath(videoPath);
  const sourceStat = await fs.stat(videoPath);
  const existing = state.episodes[stateKey];
  const existingFingerprints = artifactStoryFingerprints(existing);
  const selectedOutputs = {
    outputAudio: options.outputAudio !== false,
    outputVideo: options.outputVideo !== false,
    outputTimeline: options.outputTimeline !== false,
    outputTranscript: options.outputTranscript !== false,
  };
  const selectedArtifacts = {
    outputPath: selectedOutputs.outputAudio,
    finalVideoPath: selectedOutputs.outputVideo,
    timelinePath: selectedOutputs.outputTimeline,
  };
  const planningStatus = episodePlanningStatus(existing);
  const repairsSelectedOutput = planningStatus.repairArtifacts.some((key) => selectedArtifacts[key]);
  const needsAudio = selectedOutputs.outputAudio || selectedOutputs.outputVideo;
  const timings = {};
  let activeStage;
  let stageStarted = Date.now();
  const stage = (name) => {
    const now = Date.now();
    if (activeStage) timings[activeStage] = (timings[activeStage] || 0) + now - stageStarted;
    activeStage = name; stageStarted = now;
    onStage?.(name);
  };



  try {
    if (storyInput?.error) throw storyInput.error;
    stage('probing');
    const probe = await probeMedia(videoPath, options.ffprobe, options.signal);
    if (!probe.hasVideo) throw new Error('输入没有视频流: ' + videoPath);
    const freezeTailSeconds = freezeTailDuration(options.freezeTail, probe.frameRate);
    if (freezeTailSeconds >= probe.duration) throw new Error('片尾定格时长必须小于视频总时长');
    const musicDuration = probe.duration - freezeTailSeconds;
    if (storyInput?.error) throw storyInput.error;
    const localSubtitle = options.localVisionEnabled
      ? await findSubtitleForVideo(videoPath, options.localSubtitlePath, options.localSubtitleVideoCount || 1, probe.duration)
      : null;
    const localSubtitleStat = localSubtitle ? await fs.stat(localSubtitle.path) : null;
    const transcript = localSubtitle || await findTranscript(videoPath, options.transcripts, probe.duration);
    const transcriptStat = transcript ? await fs.stat(transcript.path) : null;
    const transcriptionModel = options.transcribe ? (options.modelPath || process.env.FASTER_WHISPER_MODEL || 'small') : null;
    const transcriptionLanguage = options.transcribe ? (options.language || process.env.FASTER_WHISPER_LANGUAGE || 'auto') : null;
    // Story identity is checked before the intentionally permissive legacy resume shortcut.
    const document = storyInput?.document || null;
    const storyFingerprint = storyFingerprintFor(options, document, localSubtitleStat
      ? { path: localSubtitle.path, size: localSubtitleStat.size, mtimeMs: localSubtitleStat.mtimeMs,
        ctimeMs: localSubtitleStat.ctimeMs, contentSha256: localSubtitle.contentSha256 }
      : null, sourceStat);
    const signature = createHash('sha256').update(JSON.stringify({
      version: STATE_VERSION,
      finalVideo: true,
      sourceSize: sourceStat.size,
      sourceMtimeMs: Math.trunc(sourceStat.mtimeMs),
      sourceCtimeMs: Math.trunc(sourceStat.ctimeMs),
      sourceBirthtimeMs: Math.trunc(sourceStat.birthtimeMs),
      catalogSignature,
      mood: options.mood,
      scenePriority: options.scenePriority !== false,
      minTracksPerEpisode: options.minTracksPerEpisode,
      transcribe: options.transcribe,
      localVisionEnabled: Boolean(options.localVisionEnabled),
      transcriptionModel,
      transcriptionLanguage,
      transcript: transcriptStat && [transcript.path, transcriptStat.size, Math.trunc(transcriptStat.mtimeMs),
        Math.trunc(transcriptStat.ctimeMs), localSubtitle?.contentSha256],
      duckDb: options.duckDb,
      autoDuck: options.autoDuck,
      freezeTail: options.freezeTail || '0:00',
      maxTracksPerEpisode: options.maxTracksPerEpisode > 0 ? options.maxTracksPerEpisode : undefined,
      maxTrackDuration: maxTrackDuration(options),
      fadeIn: options.fadeIn,
      fadeOut: options.fadeOut,
      transitionFadeEnabled: options.transitionFadeEnabled !== false,
      transitionFadeDuration: transitionFadeSeconds(options),
      strictInstrumental: options.strictInstrumental !== false,
      analysisVersion: ANALYSIS_VERSION,
      analysisSettings: ANALYSIS_SETTINGS,
      modelSha256: MODEL_SHA256,
      planningVersion: PLANNING_VERSION,
      storyFingerprint,
    })).digest('hex');
    const sameStory = options.localVisionEnabled
      ? existing?.localVisionEnabled === true && existing?.storyFingerprint === storyFingerprint && Boolean(existing?.analysis?.localVision)
      : options.storyEnabled
      ? existing?.storyFingerprint === storyFingerprint && Boolean(existing?.analysis?.story)
      : !existing?.storyEnabled && !existing?.localVisionEnabled && !existing?.analysis?.story && !existing?.analysis?.localVision;
    const transcriptRequired = Boolean(options.localVisionEnabled || options.transcribe && probe.hasAudio);
    const ownsAsrTranscript = existing?.transcriptPath === asrTranscriptPath;
    if (!options.overwrite && selectedOutputs.outputTranscript && transcriptRequired && await pathExists(asrTranscriptPath) && !ownsAsrTranscript) {
      throw new Error('转录输出已存在，拒绝覆盖非本程序创建的文件: ' + asrTranscriptPath);
    }

    const transcriptOutputValid = !selectedOutputs.outputTranscript || !transcriptRequired ||
      (ownsAsrTranscript && existingFingerprints.transcriptPath === storyFingerprint && await pathExists(asrTranscriptPath));
    if (!repairsSelectedOutput && options.skipCompleted !== false && existing?.status === 'completed' && sameStory &&
      (!options.localVisionEnabled || existing.signature === signature) &&
      (!selectedOutputs.outputAudio || (existingFingerprints.outputPath === storyFingerprint && existing.outputPath === outputPath && await outputIsValid(outputPath, musicDuration, options.ffprobe, options.ffmpeg, options.signal, Boolean(existing.analysis?.segments?.length && existing.analysis.segments.every((segment) => !segment.track))))) &&
      (!selectedOutputs.outputVideo || (existingFingerprints.finalVideoPath === storyFingerprint && existing.finalVideoPath === finalVideoPath && await finalVideoIsValid(finalVideoPath, probe.duration, options.ffprobe, options.ffmpeg, options.signal))) &&
      (!selectedOutputs.outputTimeline || (existingFingerprints.timelinePath === storyFingerprint && existing.timelinePath === timelinePath && await pathExists(timelinePath))) && transcriptOutputValid) {
      state.episodes[stateKey] = {
        ...existing, episode, status: 'completed', videoPath, ...selectedOutputs,
        artifactStoryFingerprints: existingFingerprints,
        outputPath: selectedOutputs.outputAudio ? outputPath : existing.outputPath || '',
        finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : existing.finalVideoPath || '',
        timelinePath: selectedOutputs.outputTimeline ? timelinePath : existing.timelinePath || '',
        transcriptPath: selectedOutputs.outputTranscript ? existing.transcriptPath || (transcriptRequired ? asrTranscriptPath : '') : existing.transcriptPath || '',
        transcribe: Boolean(options.transcribe),
      };
      await writeState(path.join(outputDir, '.mvp-state.json'), state);
      return {
        status: 'skipped', episode,
        analysisVersion: existing.analysisVersion || 'legacy',
        ...planningStatus,
        outputPath: selectedOutputs.outputAudio ? outputPath : '',
        finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : '',
        timelinePath: selectedOutputs.outputTimeline ? timelinePath : '',
        transcriptPath: selectedOutputs.outputTranscript && transcriptRequired ? asrTranscriptPath : undefined,
        ...selectedOutputs, duration: probe.duration,
      };
    }

    if (repairsSelectedOutput) onRepair?.();
    if (!groups.size && !options.storyEnabled) throw new Error(libraryUnavailableReason);
    const ownsOutput = existing?.outputPath === outputPath;
    const ownsTimeline = existing?.timelinePath === timelinePath;
    const ownsFinalVideo = existing?.finalVideoPath === finalVideoPath;
    const outputExists = selectedOutputs.outputAudio && await pathExists(outputPath);
    const timelineExists = selectedOutputs.outputTimeline && await pathExists(timelinePath);
    const finalVideoExists = selectedOutputs.outputVideo && await pathExists(finalVideoPath);
    if (!options.overwrite && (outputExists && !ownsOutput || timelineExists && !ownsTimeline || finalVideoExists && !ownsFinalVideo)) {
      throw new Error('输出已存在，若要覆盖请加 --overwrite: ' + episode);
    }

    onProcessing?.();
    state.episodes[stateKey] = {
      ...existing, episode, status: 'processing', error: '', signature, storyFingerprint,
      storyEnabled: Boolean(options.storyEnabled), localVisionEnabled: Boolean(options.localVisionEnabled),
      pendingSilenceRepairs: planningStatus.repairArtifacts,
      artifactStoryFingerprints: existingFingerprints,
      sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs,
      videoPath, ...selectedOutputs,
      outputPath: selectedOutputs.outputAudio ? outputPath : existing?.outputPath || '',
      finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : existing?.finalVideoPath || '',
      timelinePath: selectedOutputs.outputTimeline ? timelinePath : existing?.timelinePath || '',
      transcriptPath: selectedOutputs.outputTranscript ? existing?.transcriptPath || (transcriptRequired ? asrTranscriptPath : '') : existing?.transcriptPath || '',
      transcribe: Boolean(options.transcribe), updatedAt: new Date().toISOString(),
    };
    await writeState(path.join(outputDir, '.mvp-state.json'), state);



    let activeTranscript = transcript;
    if (!activeTranscript && options.transcribe && probe.hasAudio) {
      stage('transcribing');
      activeTranscript = await runTranscriber(videoPath, tempTranscriptPath, options);
    }
    if (options.storyEnabled) assertStoryTranscript(activeTranscript);

    stage('detecting-scenes');
    let sceneCuts = [];
    let sceneError = '';
    try { sceneCuts = await detectSceneCandidates(videoPath, musicDuration, options); }
    catch (error) { if (options.signal?.aborted) throw error; if (options.scenePriority !== false) throw new Error('转场必换曲已开启，但转场检测失败：' + error.message); sceneError = error.message; }
    let storyPlan;
    if (options.storyEnabled) {
      stage('analyzing-story');
      options.signal?.throwIfAborted();
      storyPlan = await options.createStoryPlan({ document, transcript: activeTranscript, groups, sceneCuts, duration: musicDuration, signal: options.signal });
      options.signal?.throwIfAborted();
    }
    let localVisionPlan;
    if (options.localVisionEnabled) {
      if (typeof options.createLocalVisionPlan !== 'function') throw new Error('本地画面配乐模型未配置，请在设置中下载并校验模型。');
      stage('sampling-frames');
      localVisionPlan = await withSampledVideoFrames(videoPath, musicDuration, sceneCuts, {
        ffmpeg: options.ffmpeg,
        signal: options.signal,
        onProgress: (progress) => onVisionProgress?.({ stage: 'sampling-frames', frame: progress.completed, frames: progress.total }),
        async analyze(frames) {
          stage('analyzing-vision');
          options.signal?.throwIfAborted();
          const plan = await options.createLocalVisionPlan({
            transcript: activeTranscript, frames, groups, sceneCuts, duration: musicDuration, signal: options.signal,
            onProgress: (progress) => onVisionProgress?.(progress),
          });
          options.signal?.throwIfAborted();
          return { ...plan, frames: frames.map(({ time }) => ({ time })) };
        },
      });
    }
    stage('planning');
    const intervals = mergeIntervals(activeTranscript?.segments || [], probe.duration);
    const musicPlan = buildMusicPlan({
      duration: musicDuration,
      transcript: activeTranscript,
      groups,
      options,
      trackUses: new Map(Object.entries(state.trackUses)),
      sceneCuts,
      document,
      storyPlan,
      frames: localVisionPlan?.frames,
      localVisionPlan,
    });
    const filter = buildMultiTrackFilter(musicPlan.segments, musicDuration, options, intervals, probe.hasAudio);

    await removeIfExists(tempOutputPath);
    await removeIfExists(tempFinalVideoPath);
    await removeIfExists(tempTimelinePath);
    if (needsAudio) {
      stage('rendering-audio');
      const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
      for (const segment of musicPlan.segments) {
        if (segment.track) ffmpegArgs.push('-stream_loop', '-1', '-i', segment.track);
        else ffmpegArgs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
      }
      ffmpegArgs.push(
        '-filter_complex', filter,
        '-map', '[aout]',
        '-t', formatNumber(musicDuration),
        '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
        tempOutputPath,
      );
      await runProcess(options.ffmpeg, ffmpegArgs, { signal: options.signal });
      if (!(await outputIsValid(tempOutputPath, musicDuration, options.ffprobe, options.ffmpeg, options.signal, musicPlan.segments.every((segment) => !segment.track)))) throw new Error('输出 WAV 校验失败');
    }
    if (selectedOutputs.outputVideo) {
      stage('rendering-video');
      await renderFinalVideo(videoPath, tempOutputPath, tempFinalVideoPath, probe, options);
      if (!(await finalVideoIsValid(tempFinalVideoPath, probe.duration, options.ffprobe, options.ffmpeg, options.signal))) throw new Error('最终成片校验失败');
    }
    stage('saving');
    if (selectedOutputs.outputTimeline) {
      const csv = timelineCsv({ episode, segments: musicPlan.segments, options: { ...options, hasOriginalAudio: probe.hasAudio }, intervals, freezeTailSeconds, trackCount: musicPlan.trackCount });
      await fs.writeFile(tempTimelinePath, '\uFEFF' + csv, 'utf8');
    }
    if (selectedOutputs.outputAudio) await fs.rename(tempOutputPath, outputPath);
    if (selectedOutputs.outputVideo) await fs.rename(tempFinalVideoPath, finalVideoPath);
    if (selectedOutputs.outputTimeline) await fs.rename(tempTimelinePath, timelinePath);
    const saveTranscript = Boolean(selectedOutputs.outputTranscript && (options.transcribe || options.localVisionEnabled) && activeTranscript);
    if (saveTranscript) {
      const savedTranscript = {
        source: activeTranscript.source || (options.localVisionEnabled ? 'srt' : 'asr'),
        ...(activeTranscript.language ? { language: activeTranscript.language, language_probability: activeTranscript.languageProbability } : {}),
        segments: activeTranscript.segments,
      };
      await fs.writeFile(tempTranscriptOutputPath, JSON.stringify(savedTranscript, null, 2) + '\n', 'utf8');
      await fs.rename(tempTranscriptOutputPath, asrTranscriptPath);
    }

    for (const segment of musicPlan.segments) if (segment.track) state.trackUses[segment.track] = (state.trackUses[segment.track] || 0) + 1;
    const moods = musicPlan.segments.map((segment) => segment.mood);
    const tracks = musicPlan.segments.map((segment) => segment.track);
    const duckIntervals = options.autoDuck && options.duckDb < 0 ? musicPlan.segments.flatMap((segment) => segment.track ? clipIntervals(intervals, segment.start, segment.end) : []) : [];
    stage('completed');
    const analysis = { version: PLANNING_VERSION, vocalVersion: ANALYSIS_VERSION, strictInstrumental: options.strictInstrumental !== false,
      ...(musicPlan.story ? { story: musicPlan.story } : {}),
      ...(musicPlan.localVision ? { localVision: musicPlan.localVision } : {}),
      wordTimestamps: Boolean(activeTranscript?.segments.some((segment) => segment.words?.length)), sceneCandidates: musicPlan.sceneCandidates, sceneError,
      segments: musicPlan.segments, timings, scenePriority: options.scenePriority !== false, trackCount: musicPlan.trackCount,
      maxTrackDuration: maxTrackDuration(options),
      needsReview: Boolean(sceneError || !musicPlan.trackCount.met || musicPlan.segments.some((segment) => segment.review)),
      ducking: { enabled: Boolean(duckIntervals.length), db: duckIntervals.length ? options.duckDb : 0, attackSeconds: duckIntervals.length ? 0.12 : 0, releaseSeconds: duckIntervals.length ? 0.12 : 0, intervals: duckIntervals },
      originalAudioPreserved: probe.hasAudio, originalMusicChecked: false,
    };
    const fingerprints = { ...existingFingerprints };
    // A fresh model plan can differ for identical inputs; it cannot certify retained artifacts.
    if (options.storyEnabled || options.localVisionEnabled) {
      for (const [key, selected] of Object.entries({ outputPath: selectedOutputs.outputAudio,
        finalVideoPath: selectedOutputs.outputVideo, timelinePath: selectedOutputs.outputTimeline })) {
        if (!selected && existing?.[key]) fingerprints[key] = null;
      }
    }
    if (selectedOutputs.outputAudio) fingerprints.outputPath = storyFingerprint;
    if (selectedOutputs.outputVideo) fingerprints.finalVideoPath = storyFingerprint;
    if (selectedOutputs.outputTimeline) fingerprints.timelinePath = storyFingerprint;
    if (saveTranscript) fingerprints.transcriptPath = storyFingerprint;
    state.episodes[stateKey] = {
      ...state.episodes[stateKey], status: 'completed', signature, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs,
      localVisionEnabled: Boolean(options.localVisionEnabled),
      pendingSilenceRepairs: planningStatus.repairArtifacts.filter((key) => !selectedArtifacts[key]),
      artifactStoryFingerprints: fingerprints,
      episode, videoPath, ...selectedOutputs,
      outputPath: selectedOutputs.outputAudio ? outputPath : existing?.outputPath || '',
      finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : existing?.finalVideoPath || '',
      timelinePath: selectedOutputs.outputTimeline ? timelinePath : existing?.timelinePath || '',
      transcriptPath: saveTranscript ? asrTranscriptPath : existing?.transcriptPath || '',
      duration: probe.duration, mood: moods.join(' → '), moods, track: tracks[0], tracks,
      transcriptSource: activeTranscript?.source || 'none', transcribe: Boolean(options.transcribe), duckSegments: intervals.length, segments: musicPlan.segments.length,
      analysisVersion: PLANNING_VERSION, analysis,
      updatedAt: new Date().toISOString(),
    };
    await writeState(path.join(outputDir, '.mvp-state.json'), state);
    return {
      status: 'completed', episode,
      outputPath: selectedOutputs.outputAudio ? outputPath : '',
      finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : '',
      timelinePath: selectedOutputs.outputTimeline ? timelinePath : '',
      transcriptPath: saveTranscript ? asrTranscriptPath : undefined,
      ...selectedOutputs, duration: probe.duration, mood: moods.join(' → '), moods, tracks,
      analysisVersion: PLANNING_VERSION, analysis,
      ...episodePlanningStatus(state.episodes[stateKey]),
    };

  } catch (error) {
    await removeIfExists(tempOutputPath);
    await removeIfExists(tempFinalVideoPath);
    await removeIfExists(tempTimelinePath);
    const interrupted = options.signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR';
    state.episodes[stateKey] = {
      ...state.episodes[stateKey], episode, videoPath, status: interrupted ? 'interrupted' : 'failed', sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs,
      error: interrupted ? '用户中断' : error.message, updatedAt: new Date().toISOString(),
    };
    await writeState(path.join(outputDir, '.mvp-state.json'), state);
    throw error;
  } finally {
    await removeIfExists(tempOutputPath);
    await removeIfExists(tempTranscriptPath);
    await removeIfExists(tempTranscriptOutputPath);
  }
}
async function runBatch(options, logger = console) {
  maxTrackDuration(options);
  if (options.storyEnabled !== undefined && typeof options.storyEnabled !== 'boolean') throw new Error('剧情辅助必须使用开关值');
  if (options.localVisionEnabled !== undefined && typeof options.localVisionEnabled !== 'boolean') throw new Error('本地画面配乐必须使用开关值');
  if (options.storyEnabled && options.localVisionEnabled) throw new Error('剧情 API 与本地画面配乐只能选择一种模式。');
  if (options.storyEnabled) {
    if (typeof options.createStoryPlan !== 'function') throw new Error('剧情辅助模型未配置，请在设置中配置模型服务后重试。');
    if (typeof options.storyPath !== 'string' || !options.storyPath.trim()) throw new Error('请选择剧情辅助使用的剧本或分镜文件/目录。');
    let stat;
    try { stat = await fs.stat(options.storyPath); } catch { throw new Error('剧本或分镜路径不可访问，请重新选择文件或目录。'); }
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('剧本或分镜路径必须是文件或目录。');
    options.transcribe = true;
  }
  if (options.localVisionEnabled) {
    if (typeof options.createLocalVisionPlan !== 'function') throw new Error('本地画面配乐模型未配置，请在设置中下载并校验模型。');
    if (typeof options.localSubtitlePath !== 'string' || !options.localSubtitlePath.trim()) throw new Error('请选择 SRT 字幕文件或字幕目录。');
    let stat;
    try { stat = await fs.stat(options.localSubtitlePath); } catch { throw new Error('SRT 字幕路径不可访问，请重新选择文件或目录。'); }
    if (!stat.isFile() && !stat.isDirectory() || stat.isFile() && path.extname(options.localSubtitlePath).toLowerCase() !== '.srt') {
      throw new Error('本地画面配乐仅支持 SRT 文件或字幕目录。');
    }
    options.transcribe = false;
  }
  if (!['all', 'unfinished', 'failed', 'episode'].includes(options.runMode || 'all')) throw new Error('不支持的批次恢复方式');
  const videosPath = normalizePath(options.videos);
  const musicPath = normalizePath(options.music);
  const outputPath = normalizePath(options.output);
  options.videos = videosPath;
  options.music = musicPath;
  options.output = outputPath;
  if (options.signal?.aborted) throw Object.assign(new Error('用户中断'), { name: 'AbortError', code: 'ABORT_ERR' });
  const allVideos = await scanVideos(videosPath);
  const statePath = path.join(outputPath, '.mvp-state.json');
  const scannedGroups = await scanMusic(musicPath);
  const storyInputs = new Map();
  const documentPaths = [];
  if (options.storyEnabled) {
    for (const video of allVideos) {
      try {
        const loaded = await loadStoryDocument(options.storyPath, video, { singleVideo: allVideos.length === 1, includePath: true });
        documentPaths.push(loaded.path);
        storyInputs.set(video, { document: { name: loaded.name, text: loaded.text, signature: loaded.signature } });
      } catch (error) {
        storyInputs.set(video, { error });
        documentPaths.push(...await unresolvedStoryPaths(options.storyPath, video));
      }
    }
  }
  const libraryPath = cachePath(musicPath, options);
  const targets = [
    statePath, statePath + '.part', libraryPath, libraryPath + '.part',
    ...['run-summary.json', 'run-report.md', 'run-errors.log'].map((name) => path.join(outputPath, name)),
  ];
  for (const video of allVideos) {
    const artifacts = episodeArtifacts(video, outputPath);
    targets.push(...Object.entries(artifacts).filter(([key]) => key.startsWith('temp')).map(([, file]) => file));
    if (options.outputAudio !== false) targets.push(artifacts.outputPath);
    if (options.outputVideo !== false) targets.push(artifacts.finalVideoPath);
    if (options.outputTimeline !== false) targets.push(artifacts.timelinePath);
    if (options.outputTranscript !== false && options.transcribe) targets.push(artifacts.asrTranscriptPath);
  }
  await assertStorySourcesSafe(options, targets, documentPaths);
  await assertSourceTargetsSafe([...allVideos, ...[...scannedGroups.values()].flat()], targets, '输入素材');
  const state = await readState(statePath);
  let videos = allVideos;
  if (options.runMode === 'failed') videos = videos.filter((video) => state.episodes[normalizePath(video)]?.status === 'failed');
  if (options.runMode === 'episode') videos = videos.filter((video) => normalizePath(video) === normalizePath(options.episodeVideoPath || ''));
  if (!videos.length) throw new Error('没有符合条件的视频；请刷新队列并检查失败项或当前选集');
  if (options.localVisionEnabled) options.localSubtitleVideoCount = videos.length;
  if (options.runMode === 'unfinished') options.skipCompleted = true;
  if (['failed', 'episode'].includes(options.runMode)) options.skipCompleted = false;
  logger.progress?.({ stage: 'scanning', total: videos.length, videosPath, musicPath, outputPath });
  const seenNames = new Set();
  for (const video of allVideos) {
    const key = path.parse(video).name.toLowerCase();
    if (seenNames.has(key)) throw new Error('视频文件名重复，无法安全生成同名输出: ' + path.basename(video));
    seenNames.add(key);
  }
  await ensureDirectory(outputPath);
  logger.progress?.({ stage: 'checking-library', total: videos.length });
  const cachedLibrary = await readLibrary(musicPath, options);
  state.musicCatalog = { ...cachedLibrary.health, ...state.musicCatalog };
  const inspected = await inspectMusicCatalog(scannedGroups, options.ffprobe, options.ffmpeg, options.signal, state);
  logger.progress?.({ stage: 'analyzing-vocals', total: videos.length });
  const libraryStarted = Date.now();
  const library = await filterLibrary(inspected.groups, options, { analyze: options.strictInstrumental !== false, signal: options.signal,
    progress: (event) => logger.progress?.({ stage: 'analyzing-vocals', library: event, total: videos.length }),
  });
  const libraryElapsedMs = Date.now() - libraryStarted;
  const savedLibrary = await readLibrary(musicPath, options);
  savedLibrary.health = state.musicCatalog;
  await writeLibrary(musicPath, savedLibrary, options);
  const groups = library.groups;
  options.trackMetadata = new Map(library.files.map((entry) => [entry.file, { ...entry, duration: inspected.files.find((file) => file.file === entry.file)?.duration }]));
  const libraryUnavailableReason = '曲库没有符合纯音乐筛选条件的曲目：' + JSON.stringify(library.counts) + '。请运行曲库分析或人工确认纯音乐；疑似人声、未扫描和失败曲目不会自动补入。' + (library.files.find((entry) => entry.analysis?.reason)?.analysis.reason || '');
  await writeState(statePath, state);
  logger.progress?.({ stage: 'scanned', total: videos.length, videosPath, musicPath, outputPath });
  const catalogRows = await Promise.all([...groups.values()].flat().map(async (file) => {
    const stat = await fs.stat(file);
    const metadata = options.trackMetadata.get(file);
    return [normalizePath(file), stat.size, Math.trunc(stat.mtimeMs), Math.trunc(stat.ctimeMs),
      metadata.status, metadata.cueIn || 0, metadata.intensity || null];
  }));
  const catalogSignature = createHash('sha256').update(JSON.stringify(catalogRows)).digest('hex');
  const results = [];
  logger.log('背景音乐检查完成：可用 ' + (inspected.checked - inspected.skipped) + ' 首，跳过无法解码或近似静音的 ' + inspected.skipped + ' 首');
  if (inspected.duplicates.length) logger.log('已跳过同名音乐副本 ' + inspected.duplicates.length + ' 份，仅分析和使用每个文件名的一份音乐；原文件保留。');
  logger.log('视频 ' + videos.length + ' 集，BGM ' + [...groups.entries()].map(([mood, tracks]) => mood + ':' + tracks.length).join(' / '));

  for (let index = 0; index < videos.length; index += 1) {
    if (options.signal?.aborted) break;
    const videoPath = videos[index];
    const progress = { index: index + 1, total: videos.length, episode: path.parse(videoPath).name, videoPath };
    const checkingCompleted = options.skipCompleted !== false && state.episodes[normalizePath(videoPath)]?.status === 'completed';
    if (checkingCompleted) {
      logger.progress?.({ ...progress, status: 'checking' });
      logger.log('[' + (index + 1) + '/' + videos.length + '] 核验已完成产物：' + path.basename(videoPath));
    } else {
      logger.progress?.({ ...progress, status: 'processing' });
      logger.log('[' + (index + 1) + '/' + videos.length + '] ' + path.basename(videoPath));
    }
    try {
      const result = await renderEpisode({
        videoPath, outputDir: outputPath, groups, state, options, catalogSignature, libraryUnavailableReason, storyInput: storyInputs.get(videoPath),
        onStage(stage) { logger.progress?.({ ...progress, stage }); },
        onRepair() { logger.log('检测到旧版中性留白：本次重新生成已选择的产物，不再跳过；原始素材保持不变。'); },
        onProcessing() {
          if (!checkingCompleted) return;
          logger.progress?.({ ...progress, status: 'processing' });
          logger.log('[' + (index + 1) + '/' + videos.length + '] ' + path.basename(videoPath));
        },
        onVisionProgress(event) {
          const safeProgress = Object.fromEntries(
            ['stage', 'frame', 'frames', 'completed', 'total', 'percent', 'backend', 'gpu']
              .filter((key) => event?.[key] !== undefined)
              .map((key) => [key, event[key]]),
          );
          logger.progress?.({ ...progress, ...safeProgress });
        },
      });
      results.push(result);
      logger.progress?.({ ...progress, ...result });
      logger.log('  ' + result.status + ': ' + result.outputPath);
      if (result.needsRegeneration) logger.log('  待重新生成: ' + result.regenerationReason);
      if (result.analysis?.trackCount?.warning) logger.log('  待检查: ' + result.analysis.trackCount.warning);
    } catch (error) {
      const interrupted = options.signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR';
      const result = { status: interrupted ? 'interrupted' : 'failed', episode: path.parse(videoPath).name, error: interrupted ? '用户中断' : error.message };
      results.push(result);
      logger.progress?.({ ...progress, ...result });
      logger.error('  ' + (interrupted ? 'interrupted' : 'failed') + ': ' + result.error);
      if (interrupted) break;
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    analysisVersion: PLANNING_VERSION,
    library: { ...library.counts, nameDuplicateCount: inspected.duplicates.length, elapsedMs: libraryElapsedMs, strictInstrumental: options.strictInstrumental !== false, vocalVersion: ANALYSIS_VERSION },
    videos: videos.length,
    completed: results.filter((item) => item.status === 'completed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    interrupted: results.filter((item) => item.status === 'interrupted').length,
    stopped: Boolean(options.signal?.aborted),
    pending: videos.length - results.length,
    results,
  };
  await fs.writeFile(path.join(outputPath, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  await writeBatchReport(outputPath, summary, videos, state);
  logger.progress?.({ stage: 'finished', summary });
  return summary;
}

async function writeBatchReport(output, summary, videos, state) {
  const cell = (value) => String(value ?? '—').replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/`/g, "'");
  const labels = { completed: '完成', skipped: '跳过', failed: '失败', interrupted: '中断', pending: '未处理' };
  const byEpisode = new Map(summary.results.map((item) => [item.episode, item]));
  const rows = await Promise.all(videos.map(async (video) => {
    const episode = path.parse(video).name;
    const saved = state.episodes[normalizePath(video)] || {};
    const result = byEpisode.get(episode);
    const status = result?.status || 'pending';
    const candidates = ['outputPath', 'finalVideoPath', 'timelinePath', 'transcriptPath'].filter((key) => ({ outputPath: saved.outputAudio, finalVideoPath: saved.outputVideo, timelinePath: saved.outputTimeline, transcriptPath: saved.outputTranscript })[key] !== false).map((key) => saved[key]).filter(Boolean);
    const artifacts = (await Promise.all(candidates.map(async (file) => await pathExists(file) ? file : ''))).filter(Boolean);
    return `| ${cell(episode)} | ${labels[status]} | ${cell((saved.tracks || []).filter(Boolean).map((track) => path.basename(track)).join(' / ') || '留白')} | ${cell(saved.mood)} | ${cell(result?.error || result?.regenerationReason || saved.analysis?.trackCount?.warning || '')} | ${cell(artifacts.join(' / '))} |`;
  }));
  const errors = summary.results.filter((item) => ['failed', 'interrupted'].includes(item.status));
  const report = [`# 批次报告`, '', `生成时间：${summary.generatedAt}`, '', `共 ${summary.videos} 集；完成 ${summary.completed}，跳过 ${summary.skipped}，失败 ${summary.failed}，中断 ${summary.interrupted}，未处理 ${summary.pending}。`, '', `分析版本：${summary.analysisVersion}；曲库筛选：${JSON.stringify(summary.library)}。疑似人声数量不是人工确认的人声曲目数。`, '', '| 集数 | 状态 | 使用音乐 | 情绪变化 | 失败原因 / 待检查 | 输出文件 |', '| --- | --- | --- | --- | --- | --- |', ...rows, '', '失败后可使用“仅重试失败项”或“继续未完成”。原始视频和音乐未修改；交付前请试听对白、切点和压低效果。原片音轨被保留，其中是否已有音乐尚未全段听辨，可能与新 BGM 叠加。词级时间和镜头候选不代表剧情语义或逐帧精度。', ''].join('\n');
  await fs.writeFile(path.join(output, 'run-report.md'), report, 'utf8');
  await fs.writeFile(path.join(output, 'run-errors.log'), errors.map((item) => `[${item.episode}] ${item.error}`).join('\n') || '本次批次没有失败或中断。\n', 'utf8');
}
module.exports = {
  PLANNING_VERSION,
  AUDIO_EXTENSIONS,
  DEFAULT_TRANSITION_FADE_SECONDS,
  VIDEO_EXTENSIONS,
  buildAudioFilter,
  buildMusicPlan,
  buildMultiTrackFilter,
  findMoodFolder,
  freezeTailDuration,
  inferMood,
  inspectMusicCatalog,
  mergeIntervals,
  normalizeTranscript,
  parseSceneCandidates,
  parseArgs,
  assertStorySourcesSafe,
  runBatch,
  scanMusic,
  scanVideos,
  staleStoryArtifacts,
  episodePlanningStatus,
  usage,
  writeBatchReport,
};




