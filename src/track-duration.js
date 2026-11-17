'use strict';

const { chooseTrack, describeTrackSelection, selectionReason } = require('./music-selection');

const DEFAULT_MAX_TRACK_DURATION = 40;
const DEFAULT_TRANSITION_FADE_SECONDS = 1;

function maxTrackDuration(options = {}) {
  const raw = options.maxTrackDuration;
  const value = raw === undefined ? DEFAULT_MAX_TRACK_DURATION
    : typeof raw === 'number' ? raw
      : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) throw new Error('单曲连续播放时长必须是非负数字（0 表示不限制）');
  return value;
}

function transitionFadeSeconds(options = {}) {
  const requested = Number(options.transitionFadeDuration);
  return Number.isFinite(requested) ? Math.max(0, requested) : DEFAULT_TRANSITION_FADE_SECONDS;
}

function playbackSpans(segments) {
  const spans = [];
  for (const [inputIndex, segment] of segments.entries()) {
    const previous = spans.at(-1);
    if (segment.continueTrack && previous?.track && previous.track === segment.track &&
      !segment.explicitSilence && !previous.explicitSilence && !segment.transition?.required &&
      previous.end === segment.start && (previous.cueIn || 0) === (segment.cueIn || 0)) {
      previous.end = segment.end;
    } else spans.push({ ...segment, inputIndex });
  }
  return spans;
}

function continuousRuns(segments) {
  const runs = [];
  for (const [index, segment] of segments.entries()) {
    const previous = runs.at(-1);
    if (segment.track && !segment.explicitSilence && previous?.track === segment.track &&
      previous.end === segment.start) {
      previous.end = segment.end;
      previous.last = index;
    } else runs.push({ track: segment.explicitSilence ? null : segment.track,
      start: segment.start, end: segment.end, first: index, last: index });
  }
  return runs;
}

function playbackWindows(segments, duration, options = {}) {
  const spans = playbackSpans(segments);
  const limit = maxTrackDuration(options);
  const crossfade = spans.length > 1 && options.transitionFadeEnabled !== false
    ? Math.min(transitionFadeSeconds(options), ...spans.map((segment) => (segment.end - segment.start) / 2))
    : 0;
  const pads = spans.map((segment, index) => index && !segment.explicitSilence &&
    !spans[index - 1].explicitSilence ? crossfade / 2 : 0);
  pads.push(0);
  if (limit) for (const run of continuousRuns(spans)) {
    if (!run.track) continue;
    const before = pads[run.first];
    const after = pads[run.last + 1];
    const slack = Math.max(0, limit - (run.end - run.start));
    // Allocate only available fade headroom at the outside of a same-file run.
    const scale = before + after > slack ? slack / (before + after) : 1;
    pads[run.first] *= scale;
    pads[run.last + 1] *= scale;
  }
  return spans.map((segment, index) => {
    const renderStart = index ? Math.max(0, segment.start - pads[index]) : 0;
    const renderEnd = index === spans.length - 1 ? duration : Math.min(duration, segment.end + pads[index + 1]);
    const length = renderEnd - renderStart;
    return { ...segment, renderStart, renderEnd,
      fadeIn: index ? Math.min(pads[index] * 2, length) : Math.min(Math.max(0, Number(options.fadeIn) || 0), length),
      fadeOut: index === spans.length - 1 ? Math.min(Math.max(0, Number(options.fadeOut) || 0), length) : Math.min(pads[index + 1] * 2, length) };
  });
}

function enforceTrackDuration(plan, context) {
  const { groups, options = {}, trackUses = new Map() } = context;
  const limit = maxTrackDuration(options);
  if (!limit) return plan;
  const segments = plan.segments.map((segment) => ({ ...segment }));
  const episodeTracks = new Set(segments.map((segment) => segment.track).filter(Boolean));
  const margin = options.transitionFadeEnabled === false ? 0 : Math.min(transitionFadeSeconds(options) / 2, limit / 4);
  const replacementTrack = (segment, outgoing, nextRequired) => {
    const mood = segment.requestedMood ?? segment.mood;
    let candidates = groups;
    let track;
    while ((track = chooseTrack(candidates, mood, trackUses, episodeTracks, options.trackMetadata,
      false, outgoing, plan.story ? segment.intensity : undefined))) {
      if (!nextRequired?.transition?.required || nextRequired.explicitSilence ||
        chooseTrack(groups, nextRequired.requestedMood ?? nextRequired.mood, trackUses, episodeTracks,
          options.trackMetadata, false, track, plan.story ? nextRequired.intensity : undefined)) break;
      // Do not consume the next scene's only usable track during an earlier change.
      candidates = new Map([...candidates].map(([name, tracks]) => [name, tracks.filter((file) => file !== track)]));
    }
    return track;
  };
  const replace = (segment, outgoing, time, reason, nextRequired) => {
    const mood = segment.requestedMood ?? segment.mood;
    const track = replacementTrack(segment, outgoing, nextRequired);
    if (!track) throw new Error(`${Number(time.toFixed(3))} 秒处${reason}，但没有另一首匹配情绪、相近风格或兼容中性的合格曲目；请补充或确认至少两首合适曲目后重试。`);
    const metadata = options.trackMetadata?.get(track);
    const selection = describeTrackSelection(groups, mood, track);
    episodeTracks.add(track);
    trackUses.set(track, (trackUses.get(track) || 0) + 1);
    return { ...segment, track, ...selection, review: true,
      reason: [segment.reason, reason, selectionReason(selection)].filter(Boolean).join('；'),
      cueIn: metadata?.cueIn || 0, intensity: plan.story ? segment.intensity : metadata?.intensity || null,
      instrumentalStatus: metadata?.status || 'unknown', vocalEvidence: metadata?.analysis?.intervals || [] };
  };
  while (true) {
    // Inserted music can coincide with a later mandatory scene selection.
    for (let index = 1; index < segments.length; index += 1) {
      if (segments[index].track && segments[index].transition?.required &&
        segments[index].track === segments[index - 1].track) {
        segments[index] = replace(segments[index], segments[index - 1].track,
          segments[index].start, '转场必须换曲', segments[index + 1]);
      }
    }
    const run = continuousRuns(segments).find((entry) => entry.track && entry.end - entry.start > limit + 1e-9);
    if (!run) break;
    const incoming = run.first && segments[run.first - 1].track ? margin : 0;
    const boundary = run.start - incoming + limit - margin;
    const reason = `单曲连续播放上限 ${limit} 秒，到点必须换曲`;
    const transitionAt = (time) => ({ boundary: time, durationLimit: true, required: true, changeTrack: true, reason });
    // Replace one bounded interval, leaving later valid original selections intact.
    let replacementEnd = run.end - boundary <= limit ? run.end : boundary + limit - 2 * margin;
    const boundarySource = segments.find((segment, index) => index >= run.first && index <= run.last && segment.end > boundary);
    const following = segments[run.last + 1];
    if (replacementEnd === run.end && !replacementTrack(boundarySource, run.track, following) &&
      replacementTrack(boundarySource, run.track)) {
      // A brief real change followed by the original track can preserve a scarce next scene.
      replacementEnd = (boundary + run.end) / 2;
    }
    const lastIndex = segments.findIndex((segment, index) => index >= run.first && index <= run.last && segment.end >= replacementEnd);
    const last = segments[lastIndex];
    if (last.end > replacementEnd) {
      segments.splice(lastIndex, 1, { ...last, end: replacementEnd },
        { ...last, start: replacementEnd, transition: transitionAt(replacementEnd), reason: [last.reason, reason].filter(Boolean).join('；') });
    } else if (replacementEnd < run.end) {
      segments[lastIndex + 1] = { ...segments[lastIndex + 1], transition: transitionAt(replacementEnd),
        reason: [segments[lastIndex + 1].reason, reason].filter(Boolean).join('；') };
    }
    run.last = lastIndex;
    const splitIndex = segments.findIndex((segment, index) => index >= run.first && index <= run.last && segment.end > boundary);
    const source = segments[splitIndex];
    const nextRequired = segments[run.last + 1];
    let replacement = replace(source, run.track, boundary, reason, nextRequired);
    const transition = transitionAt(boundary);
    const tail = { ...replacement, start: boundary, transition };
    if (boundary > source.start) {
      segments.splice(splitIndex, 1, { ...source, end: boundary }, tail);
      run.last += 1;
    } else segments[splitIndex] = { ...tail, transition: { ...source.transition, ...transition } };
    const tailIndex = boundary > source.start ? splitIndex + 1 : splitIndex;
    for (let index = tailIndex + 1; index <= run.last; index += 1) {
      const segment = segments[index];
      const mood = segment.requestedMood ?? segment.mood;
      const selection = describeTrackSelection(groups, mood, replacement.track);
      if (mood && selection.matchType === 'library') replacement = replace(segment, run.track, segment.start, reason, nextRequired);
      else replacement = { ...segment, track: replacement.track, ...selection,
        reason: [segment.reason, reason, selectionReason(selection)].filter(Boolean).join('；'),
        review: true, cueIn: replacement.cueIn,
        intensity: plan.story ? segment.intensity : replacement.intensity,
        instrumentalStatus: replacement.instrumentalStatus, vocalEvidence: replacement.vocalEvidence };
      segments[index] = replacement;
    }
  }
  for (const [index, segment] of segments.entries()) {
    segment.continueTrack = Boolean(segment.track && index && segment.track === segments[index - 1].track &&
      !segment.transition?.required && (segment.cueIn || 0) === (segments[index - 1].cueIn || 0));
  }
  const actual = new Set(segments.map((segment) => segment.track).filter(Boolean)).size;
  const minimum = plan.trackCount.minimum;
  const trackCount = { ...plan.trackCount, actual, segments: segments.length, met: actual >= minimum,
    warning: actual >= minimum ? '' : plan.trackCount.warning };
  return { ...plan, segments, trackCount, maxTrackDuration: limit };
}

module.exports = { DEFAULT_MAX_TRACK_DURATION, DEFAULT_TRANSITION_FADE_SECONDS, enforceTrackDuration,
  maxTrackDuration, playbackWindows, transitionFadeSeconds };
