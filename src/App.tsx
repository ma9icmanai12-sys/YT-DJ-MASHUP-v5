import React, { useState, useEffect, useRef, useCallback } from 'react';
import { DeckState, DeckTrack, CrossfaderCurve, MashupPreset, MixHistoryEvent } from './types/dj';
import { POPULAR_TRACKS, MASHUP_PRESETS } from './data/presets';
import { createYTPlayer, YTPlayerWrapper } from './services/youtube';
import { audioFx } from './services/audioFx';
import { Header } from './components/Header';
import { TopMashupVideoStage } from './components/TopMashupVideoStage';
import { Deck } from './components/Deck';
import { MasterMixer } from './components/MasterMixer';
import { SamplerPads } from './components/SamplerPads';
import { OpenMixFxRack } from './components/OpenMixFxRack';
import { MidiControllerModal } from './components/MidiControllerModal';
import { DjControllerEngine, ControllerDevice, DjActionKey } from './services/controller';
import { CrateModal } from './components/CrateModal';
import { RecordingModal } from './components/RecordingModal';
import { ShortcutsModal } from './components/ShortcutsModal';

export default function App() {
  // Preset default tracks
  const defaultTrackA = POPULAR_TRACKS[4]; // The Weeknd - Blinding Lights (171 BPM)
  const defaultTrackB = POPULAR_TRACKS[5]; // a-ha - Take On Me (168 BPM)

  // Deck A State
  const [deckA, setDeckA] = useState<DeckState>({
    id: 'A',
    track: defaultTrackA,
    isPlaying: false,
    currentTime: 0,
    duration: defaultTrackA.duration,
    volume: 85,
    gain: 0,
    pitch: 0,
    pitchRange: 8,
    keyLock: true,
    effectiveBpm: defaultTrackA.bpm,
    tapBpmTimes: [],
    eq: { high: 0, mid: 0, low: 0 },
    eqKill: { high: false, mid: false, low: false },
    filter: 0,
    hotCues: [
      { id: 1, time: 15, label: 'Drop', color: '#06b6d4' },
      { id: 2, time: 45, label: 'Chorus', color: '#f59e0b' },
    ],
    loop: { active: false, lengthBeats: 4, startTime: null },
    pfl: false,
    isScratching: false,
    vinylAngle: 0,
  });

  // Deck B State
  const [deckB, setDeckB] = useState<DeckState>({
    id: 'B',
    track: defaultTrackB,
    isPlaying: false,
    currentTime: 0,
    duration: defaultTrackB.duration,
    volume: 85,
    gain: 0,
    pitch: 0,
    pitchRange: 8,
    keyLock: true,
    effectiveBpm: defaultTrackB.bpm,
    tapBpmTimes: [],
    eq: { high: 0, mid: 0, low: 0 },
    eqKill: { high: false, mid: false, low: false },
    filter: 0,
    hotCues: [
      { id: 1, time: 20, label: 'Intro Synth', color: '#10b981' },
      { id: 2, time: 55, label: 'Vocals', color: '#ec4899' },
    ],
    loop: { active: false, lengthBeats: 4, startTime: null },
    pfl: false,
    isScratching: false,
    vinylAngle: 0,
  });

  // Master Mixer State
  const [masterVolume, setMasterVolume] = useState<number>(90);
  const [crossfader, setCrossfader] = useState<number>(0); // -1 (Deck A) to +1 (Deck B)
  const [crossfaderCurve, setCrossfaderCurve] = useState<CrossfaderCurve>('smooth');
  const [isAutoTransitioning, setIsAutoTransitioning] = useState<boolean>(false);
  const [autoTransitionProgress, setAutoTransitionProgress] = useState<number>(0);

  // App Display & Navigation State
  const [displayMode, setDisplayMode] = useState<'dual' | 'blend' | 'audio-only'>('blend');
  const [isCrateModalOpen, setIsCrateModalOpen] = useState<boolean>(false);
  const [isRecordingModalOpen, setIsRecordingModalOpen] = useState<boolean>(false);
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [embedErrorA, setEmbedErrorA] = useState<boolean>(false);
  const [embedErrorB, setEmbedErrorB] = useState<boolean>(false);

  // OpenMix Hardware Controller & MIDI State
  const [isMidiModalOpen, setIsMidiModalOpen] = useState<boolean>(false);
  const [controllerDevices, setControllerDevices] = useState<ControllerDevice[]>([]);
  const [learningAction, setLearningAction] = useState<DjActionKey | null>(null);
  const controllerEngineRef = useRef<DjControllerEngine | null>(null);

  // Mix Session Recorder State
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [mixEvents, setMixEvents] = useState<MixHistoryEvent[]>([]);
  const [customTracks, setCustomTracks] = useState<DeckTrack[]>([]);

  // YouTube Player References
  const playerARef = useRef<YTPlayerWrapper | null>(null);
  const playerBRef = useRef<YTPlayerWrapper | null>(null);

  // Cue point backup reference for CDJ Cue behavior
  const cuePointARef = useRef<number>(15);
  const cuePointBRef = useRef<number>(20);

  // Helper to log actions when recording
  const logMixAction = useCallback((action: string, deck?: 'A' | 'B', details?: string) => {
    if (!isRecording) return;
    setMixEvents(prev => [
      ...prev,
      {
        timestamp: Date.now(),
        action,
        deck,
        details,
      },
    ]);
  }, [isRecording]);

  // Calculate and apply physical output volumes to YouTube players
  useEffect(() => {
    // Crossfader curves:
    // pos ranges from 0 (Deck A full) to 1 (Deck B full)
    const pos = (crossfader + 1) / 2;
    let cfWeightA = 1;
    let cfWeightB = 1;

    if (crossfaderCurve === 'smooth') {
      // Equal-power constant loudness curve
      cfWeightA = Math.cos(pos * (Math.PI / 2));
      cfWeightB = Math.sin(pos * (Math.PI / 2));
    } else if (crossfaderCurve === 'linear') {
      cfWeightA = 1 - pos;
      cfWeightB = pos;
    } else if (crossfaderCurve === 'cut') {
      // Scratch cut curve: instant full level unless slammed all the way
      cfWeightA = pos > 0.95 ? 0 : 1;
      cfWeightB = pos < 0.05 ? 0 : 1;
    }

    // 3-Band EQ calculation (Low/Bass: 45%, Mid/Vocal: 35%, High/Treble: 20%)
    // Each band ranges from -100 (total kill, 0x) to 0 (unity, 1x) to +100 (+6dB boost, 1.45x)
    const lowMultA = deckA.eqKill.low ? 0 : Math.max(0, 1 + deckA.eq.low / 100);
    const midMultA = deckA.eqKill.mid ? 0 : Math.max(0, 1 + deckA.eq.mid / 100);
    const highMultA = deckA.eqKill.high ? 0 : Math.max(0, 1 + deckA.eq.high / 100);
    const eqScaleA = 0.45 * lowMultA + 0.35 * midMultA + 0.20 * highMultA;

    // Filter knob (-100 full lowpass to +100 full highpass)
    const filterAttenA = deckA.filter < 0
      ? Math.max(0.15, 1 + (deckA.filter / 100) * 0.75) // Lowpass muffles sound
      : Math.max(0.15, 1 - (deckA.filter / 100) * 0.75); // Highpass thins sound

    const totalEqFactorA = Math.max(0, Math.min(1.5, eqScaleA * filterAttenA));

    // Deck B EQ
    const lowMultB = deckB.eqKill.low ? 0 : Math.max(0, 1 + deckB.eq.low / 100);
    const midMultB = deckB.eqKill.mid ? 0 : Math.max(0, 1 + deckB.eq.mid / 100);
    const highMultB = deckB.eqKill.high ? 0 : Math.max(0, 1 + deckB.eq.high / 100);
    const eqScaleB = 0.45 * lowMultB + 0.35 * midMultB + 0.20 * highMultB;

    const filterAttenB = deckB.filter < 0
      ? Math.max(0.15, 1 + (deckB.filter / 100) * 0.75)
      : Math.max(0.15, 1 - (deckB.filter / 100) * 0.75);

    const totalEqFactorB = Math.max(0, Math.min(1.5, eqScaleB * filterAttenB));

    const masterFactor = masterVolume / 100;
    const finalVolA = Math.round(Math.min(100, (deckA.volume / 100) * cfWeightA * totalEqFactorA * masterFactor * 100));
    const finalVolB = Math.round(Math.min(100, (deckB.volume / 100) * cfWeightB * totalEqFactorB * masterFactor * 100));

    if (playerARef.current) {
      playerARef.current.setVolume(finalVolA);
    }
    if (playerBRef.current) {
      playerBRef.current.setVolume(finalVolB);
    }
  }, [
    crossfader,
    crossfaderCurve,
    deckA.volume,
    deckB.volume,
    deckA.eq,
    deckB.eq,
    deckA.eqKill,
    deckB.eqKill,
    deckA.filter,
    deckB.filter,
    masterVolume,
  ]);

  // Initialize YouTube Players when mounted
  useEffect(() => {
    let mounted = true;

    const initPlayers = async () => {
      try {
        // Player A
        if (!playerARef.current && deckA.track) {
          await createYTPlayer('deck-a-player', deckA.track.videoId, {
            onReady: (wrapper) => {
              if (!mounted) return;
              playerARef.current = wrapper;
              wrapper.setVolume(85);
            },
            onStateChange: (state) => {
              if (!mounted) return;
              // 1 = playing, 2 = paused
              if (state === 1) {
                setEmbedErrorA(false);
                setDeckA(prev => ({ ...prev, isPlaying: true }));
              } else if (state === 2 || state === 0) {
                setDeckA(prev => ({ ...prev, isPlaying: false }));
              }
            },
            onError: () => {
              if (!mounted) return;
              setEmbedErrorA(true);
            },
          });
        }

        // Player B
        if (!playerBRef.current && deckB.track) {
          await createYTPlayer('deck-b-player', deckB.track.videoId, {
            onReady: (wrapper) => {
              if (!mounted) return;
              playerBRef.current = wrapper;
              wrapper.setVolume(85);
            },
            onStateChange: (state) => {
              if (!mounted) return;
              if (state === 1) {
                setEmbedErrorB(false);
                setDeckB(prev => ({ ...prev, isPlaying: true }));
              } else if (state === 2 || state === 0) {
                setDeckB(prev => ({ ...prev, isPlaying: false }));
              }
            },
            onError: () => {
              if (!mounted) return;
              setEmbedErrorB(true);
            },
          });
        }
      } catch (err) {
        console.warn('Error loading YouTube players', err);
      }
    };

    initPlayers();

    return () => {
      mounted = false;
    };
  }, [deckA.track, deckB.track]);

  // Periodic poll for time update, loop enforcement, and duration
  useEffect(() => {
    const timer = setInterval(() => {
      // Deck A Update
      if (deckA.isPlaying) {
        const ytTime = playerARef.current ? playerARef.current.getCurrentTime() : 0;
        const dur = playerARef.current ? playerARef.current.getDuration() : 0;

        setDeckA(prev => {
          const nextTime = ytTime > 0 && !embedErrorA ? ytTime : prev.currentTime + 0.25;
          const loopDuration = (60 / Math.max(20, prev.effectiveBpm)) * prev.loop.lengthBeats;
          let finalTime = nextTime;

          if (prev.loop.active && prev.loop.startTime !== null && nextTime >= prev.loop.startTime + loopDuration) {
            finalTime = prev.loop.startTime;
            playerARef.current?.seekTo(prev.loop.startTime);
          }

          return {
            ...prev,
            currentTime: finalTime,
            duration: dur > 0 ? dur : prev.duration,
          };
        });
      }

      // Deck B Update
      if (deckB.isPlaying) {
        const ytTime = playerBRef.current ? playerBRef.current.getCurrentTime() : 0;
        const dur = playerBRef.current ? playerBRef.current.getDuration() : 0;

        setDeckB(prev => {
          const nextTime = ytTime > 0 && !embedErrorB ? ytTime : prev.currentTime + 0.25;
          const loopDuration = (60 / Math.max(20, prev.effectiveBpm)) * prev.loop.lengthBeats;
          let finalTime = nextTime;

          if (prev.loop.active && prev.loop.startTime !== null && nextTime >= prev.loop.startTime + loopDuration) {
            finalTime = prev.loop.startTime;
            playerBRef.current?.seekTo(prev.loop.startTime);
          }

          return {
            ...prev,
            currentTime: finalTime,
            duration: dur > 0 ? dur : prev.duration,
          };
        });
      }
    }, 250);

    return () => clearInterval(timer);
  }, [deckA.isPlaying, deckA.loop, deckA.effectiveBpm, deckB.isPlaying, deckB.loop, deckB.effectiveBpm, embedErrorA, embedErrorB]);

  // Deck Transport Handlers: Play / Pause
  const handlePlayPause = (deckId: 'A' | 'B') => {
    if (deckId === 'A') {
      if (deckA.isPlaying) {
        playerARef.current?.pause();
        setDeckA(prev => ({ ...prev, isPlaying: false }));
        logMixAction('Pause Deck A', 'A');
      } else {
        playerARef.current?.play();
        setDeckA(prev => ({ ...prev, isPlaying: true }));
        logMixAction('Play Deck A', 'A');
      }
    } else {
      if (deckB.isPlaying) {
        playerBRef.current?.pause();
        setDeckB(prev => ({ ...prev, isPlaying: false }));
        logMixAction('Pause Deck B', 'B');
      } else {
        playerBRef.current?.play();
        setDeckB(prev => ({ ...prev, isPlaying: true }));
        logMixAction('Play Deck B', 'B');
      }
    }
  };

  // Pioneer CDJ-style Cue: Return to cue point and pause
  const handleCue = (deckId: 'A' | 'B') => {
    if (deckId === 'A') {
      const cueTime = cuePointARef.current;
      playerARef.current?.pause();
      playerARef.current?.seekTo(cueTime);
      setDeckA(prev => ({ ...prev, isPlaying: false, currentTime: cueTime }));
      logMixAction(`Cue Return (${cueTime.toFixed(1)}s)`, 'A');
    } else {
      const cueTime = cuePointBRef.current;
      playerBRef.current?.pause();
      playerBRef.current?.seekTo(cueTime);
      setDeckB(prev => ({ ...prev, isPlaying: false, currentTime: cueTime }));
      logMixAction(`Cue Return (${cueTime.toFixed(1)}s)`, 'B');
    }
  };

  // Waveform Seek
  const handleSeek = (deckId: 'A' | 'B', seconds: number) => {
    if (deckId === 'A') {
      playerARef.current?.seekTo(seconds);
      setDeckA(prev => ({ ...prev, currentTime: seconds }));
      cuePointARef.current = seconds;
      logMixAction(`Seek to ${seconds.toFixed(1)}s`, 'A');
    } else {
      playerBRef.current?.seekTo(seconds);
      setDeckB(prev => ({ ...prev, currentTime: seconds }));
      cuePointBRef.current = seconds;
      logMixAction(`Seek to ${seconds.toFixed(1)}s`, 'B');
    }
  };

  // Vinyl Scratch / Scrub
  const handleScratch = (deckId: 'A' | 'B', deltaSec: number) => {
    if (deckId === 'A') {
      const newTime = Math.max(0, Math.min(deckA.duration, deckA.currentTime + deltaSec));
      playerARef.current?.seekTo(newTime);
      setDeckA(prev => ({ ...prev, currentTime: newTime }));
    } else {
      const newTime = Math.max(0, Math.min(deckB.duration, deckB.currentTime + deltaSec));
      playerBRef.current?.seekTo(newTime);
      setDeckB(prev => ({ ...prev, currentTime: newTime }));
    }
  };

  // Nudge / Bend tempo
  const handleNudge = (deckId: 'A' | 'B', dir: 1 | -1) => {
    const delta = dir * 0.4;
    handleScratch(deckId, delta);
  };

  // Pitch / Tempo Adjustment
  const handleChangePitch = (deckId: 'A' | 'B', pitch: number) => {
    if (deckId === 'A') {
      const baseBpm = deckA.track?.bpm || 120;
      const effectiveBpm = baseBpm * (1 + pitch / 100);
      setDeckA(prev => ({ ...prev, pitch, effectiveBpm }));
      // Adjust YouTube player playback rate if supported (clamped 0.5 to 2.0)
      const rate = Math.max(0.5, Math.min(2.0, 1 + pitch / 100));
      playerARef.current?.setPlaybackRate(rate);
      logMixAction(`Pitch ${pitch > 0 ? `+${pitch.toFixed(1)}` : pitch.toFixed(1)}%`, 'A');
    } else {
      const baseBpm = deckB.track?.bpm || 120;
      const effectiveBpm = baseBpm * (1 + pitch / 100);
      setDeckB(prev => ({ ...prev, pitch, effectiveBpm }));
      const rate = Math.max(0.5, Math.min(2.0, 1 + pitch / 100));
      playerBRef.current?.setPlaybackRate(rate);
      logMixAction(`Pitch ${pitch > 0 ? `+${pitch.toFixed(1)}` : pitch.toFixed(1)}%`, 'B');
    }
  };

  // Pro Beat & BPM Sync: Lock Tempo, expand range, and align beat downbeats
  const handleSyncBpm = (targetDeck: 'A' | 'B') => {
    if (targetDeck === 'A') {
      const targetBpm = deckB.effectiveBpm;
      const baseA = deckA.track?.bpm || 120;
      const neededPitch = ((targetBpm / baseA) - 1) * 100;

      // Auto-expand pitch range if needed so sync is never clamped
      const newRange: 8 | 16 | 50 = Math.abs(neededPitch) > 16 ? 50 : Math.abs(neededPitch) > 8 ? 16 : deckA.pitchRange;

      setDeckA(prev => ({
        ...prev,
        pitch: neededPitch,
        effectiveBpm: targetBpm,
        pitchRange: newRange,
      }));

      // Apply playback rate on player (clamped 0.5 to 2.0)
      const rate = Math.max(0.5, Math.min(2.0, targetBpm / baseA));
      playerARef.current?.setPlaybackRate(rate);

      // Beat Phase Sync: lock downbeats together if Deck B is playing
      if (deckB.isPlaying && targetBpm > 0) {
        const beatSec = 60 / targetBpm;
        const phaseB = deckB.currentTime % beatSec;
        const currentA = deckA.currentTime;
        const wholeBeatsA = Math.floor(currentA / beatSec);
        const alignedTime = Math.max(0, wholeBeatsA * beatSec + phaseB);
        playerARef.current?.seekTo(alignedTime);
        setDeckA(prev => ({ ...prev, currentTime: alignedTime }));
      }

      logMixAction(`Beat & BPM Sync to ${targetBpm.toFixed(1)} BPM`, 'A');
    } else {
      const targetBpm = deckA.effectiveBpm;
      const baseB = deckB.track?.bpm || 120;
      const neededPitch = ((targetBpm / baseB) - 1) * 100;

      const newRange: 8 | 16 | 50 = Math.abs(neededPitch) > 16 ? 50 : Math.abs(neededPitch) > 8 ? 16 : deckB.pitchRange;

      setDeckB(prev => ({
        ...prev,
        pitch: neededPitch,
        effectiveBpm: targetBpm,
        pitchRange: newRange,
      }));

      const rate = Math.max(0.5, Math.min(2.0, targetBpm / baseB));
      playerBRef.current?.setPlaybackRate(rate);

      if (deckA.isPlaying && targetBpm > 0) {
        const beatSec = 60 / targetBpm;
        const phaseA = deckA.currentTime % beatSec;
        const currentB = deckB.currentTime;
        const wholeBeatsB = Math.floor(currentB / beatSec);
        const alignedTime = Math.max(0, wholeBeatsB * beatSec + phaseA);
        playerBRef.current?.seekTo(alignedTime);
        setDeckB(prev => ({ ...prev, currentTime: alignedTime }));
      }

      logMixAction(`Beat & BPM Sync to ${targetBpm.toFixed(1)} BPM`, 'B');
    }
  };

  // Tap BPM Detector
  const handleTapBpm = (deckId: 'A' | 'B') => {
    const now = Date.now();
    const target = deckId === 'A' ? deckA : deckB;
    const history = [...target.tapBpmTimes, now].filter(t => now - t < 3000).slice(-6);

    if (history.length >= 2) {
      const intervals = [];
      for (let i = 1; i < history.length; i++) {
        intervals.push(history[i] - history[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const calculatedBpm = Math.round(60000 / avgInterval);

      if (calculatedBpm >= 50 && calculatedBpm <= 220) {
        if (deckId === 'A') {
          setDeckA(prev => ({
            ...prev,
            effectiveBpm: calculatedBpm,
            tapBpmTimes: history,
            track: prev.track ? { ...prev.track, bpm: calculatedBpm } : null,
          }));
        } else {
          setDeckB(prev => ({
            ...prev,
            effectiveBpm: calculatedBpm,
            tapBpmTimes: history,
            track: prev.track ? { ...prev.track, bpm: calculatedBpm } : null,
          }));
        }
        return;
      }
    }

    if (deckId === 'A') {
      setDeckA(prev => ({ ...prev, tapBpmTimes: history }));
    } else {
      setDeckB(prev => ({ ...prev, tapBpmTimes: history }));
    }
  };

  // Hot Cues: Set or Jump
  const handleTriggerCue = (deckId: 'A' | 'B', id: number) => {
    const deck = deckId === 'A' ? deckA : deckB;
    const existing = deck.hotCues.find(c => c.id === id);

    if (existing) {
      // Jump to existing cue
      handleSeek(deckId, existing.time);
      logMixAction(`Jump Hot Cue ${id} (${existing.time.toFixed(1)}s)`, deckId);
    } else {
      // Set new cue at current time
      const colors = ['#06b6d4', '#f59e0b', '#10b981', '#ec4899'];
      const newCue = {
        id,
        time: deck.currentTime,
        label: `Cue ${id}`,
        color: colors[id - 1] || '#06b6d4',
      };
      if (deckId === 'A') {
        setDeckA(prev => ({ ...prev, hotCues: [...prev.hotCues, newCue] }));
      } else {
        setDeckB(prev => ({ ...prev, hotCues: [...prev.hotCues, newCue] }));
      }
      logMixAction(`Set Hot Cue ${id} at ${deck.currentTime.toFixed(1)}s`, deckId);
    }
  };

  const handleDeleteCue = (deckId: 'A' | 'B', id: number) => {
    if (deckId === 'A') {
      setDeckA(prev => ({ ...prev, hotCues: prev.hotCues.filter(c => c.id !== id) }));
    } else {
      setDeckB(prev => ({ ...prev, hotCues: prev.hotCues.filter(c => c.id !== id) }));
    }
  };

  // Beat Loop Handlers
  const handleSetLoop = (deckId: 'A' | 'B', beats: number) => {
    const deck = deckId === 'A' ? deckA : deckB;
    if (deckId === 'A') {
      setDeckA(prev => ({
        ...prev,
        loop: {
          active: true,
          lengthBeats: beats,
          startTime: prev.loop.active && prev.loop.startTime !== null ? prev.loop.startTime : prev.currentTime,
        },
      }));
    } else {
      setDeckB(prev => ({
        ...prev,
        loop: {
          active: true,
          lengthBeats: beats,
          startTime: prev.loop.active && prev.loop.startTime !== null ? prev.loop.startTime : prev.currentTime,
        },
      }));
    }
    logMixAction(`Set Loop ${beats} Beats`, deckId);
  };

  const handleToggleLoop = (deckId: 'A' | 'B') => {
    const deck = deckId === 'A' ? deckA : deckB;
    if (deckId === 'A') {
      setDeckA(prev => ({
        ...prev,
        loop: {
          ...prev.loop,
          active: !prev.loop.active,
          startTime: !prev.loop.active ? prev.currentTime : prev.loop.startTime,
        },
      }));
    } else {
      setDeckB(prev => ({
        ...prev,
        loop: {
          ...prev.loop,
          active: !prev.loop.active,
          startTime: !prev.loop.active ? prev.currentTime : prev.loop.startTime,
        },
      }));
    }
  };

  // Automated Smooth Crossfader Transition
  const handleStartAutoTransition = (durationSec: number) => {
    if (isAutoTransitioning) return;
    setIsAutoTransitioning(true);

    const startCf = crossfader;
    // If on Deck A side, fade to Deck B (+1); otherwise fade to Deck A (-1)
    const targetCf = startCf <= 0 ? 1 : -1;
    const startTime = performance.now();
    const durationMs = durationSec * 1000;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      setAutoTransitionProgress(progress);

      // Smooth cosine easing
      const eased = (1 - Math.cos(progress * Math.PI)) / 2;
      const currentVal = startCf + (targetCf - startCf) * eased;
      setCrossfader(currentVal);

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        setCrossfader(targetCf);
        setIsAutoTransitioning(false);
        setAutoTransitionProgress(0);
        logMixAction(`Auto Transition Complete to Deck ${targetCf > 0 ? 'B' : 'A'}`);
      }
    };

    requestAnimationFrame(tick);
  };

  // Load Mashup Preset (Loads both Deck A and Deck B with preset matching, stays paused)
  const handleLoadMashupPreset = (preset: MashupPreset) => {
    setEmbedErrorA(false);
    setEmbedErrorB(false);
    // Deck A
    setDeckA(prev => ({
      ...prev,
      track: preset.deckA,
      effectiveBpm: preset.recommendedBpm,
      currentTime: preset.deckA.suggestedCue || 0,
      isPlaying: false,
    }));
    cuePointARef.current = preset.deckA.suggestedCue || 0;
    if (playerARef.current) {
      playerARef.current.cueVideoById(preset.deckA.videoId, preset.deckA.suggestedCue || 0);
      playerARef.current.pause();
    }

    // Deck B
    setDeckB(prev => ({
      ...prev,
      track: preset.deckB,
      effectiveBpm: preset.recommendedBpm,
      currentTime: preset.deckB.suggestedCue || 0,
      isPlaying: false,
    }));
    cuePointBRef.current = preset.deckB.suggestedCue || 0;
    if (playerBRef.current) {
      playerBRef.current.cueVideoById(preset.deckB.videoId, preset.deckB.suggestedCue || 0);
      playerBRef.current.pause();
    }

    logMixAction(`Loaded Mashup Preset: "${preset.title}"`);
  };

  // Load individual track to specific deck (cues in standby waiting for PLAY button)
  const handleLoadTrackToDeck = (deckId: 'A' | 'B', track: DeckTrack) => {
    // Add to custom tracks if not already present
    setCustomTracks(prev => (prev.some(t => t.id === track.id) ? prev : [track, ...prev]));

    if (deckId === 'A') {
      setEmbedErrorA(false);
      setDeckA(prev => ({
        ...prev,
        track,
        effectiveBpm: track.bpm,
        currentTime: track.suggestedCue || 0,
        isPlaying: false,
      }));
      cuePointARef.current = track.suggestedCue || 0;

      if (playerARef.current) {
        playerARef.current.cueVideoById(track.videoId, track.suggestedCue || 0);
        playerARef.current.pause();
      } else {
        createYTPlayer('deck-a-player', track.videoId, {
          onReady: (wrapper) => {
            playerARef.current = wrapper;
            wrapper.setVolume(85);
            wrapper.pause();
          },
          onStateChange: (state) => {
            if (state === 1) {
              setEmbedErrorA(false);
              setDeckA(prev => ({ ...prev, isPlaying: true }));
            } else if (state === 2 || state === 0 || state === 5) {
              setDeckA(prev => ({ ...prev, isPlaying: false }));
            }
          },
          onError: () => setEmbedErrorA(true),
        });
      }
      logMixAction(`Loaded Track: ${track.title}`, 'A');
    } else {
      setEmbedErrorB(false);
      setDeckB(prev => ({
        ...prev,
        track,
        effectiveBpm: track.bpm,
        currentTime: track.suggestedCue || 0,
        isPlaying: false,
      }));
      cuePointBRef.current = track.suggestedCue || 0;

      if (playerBRef.current) {
        playerBRef.current.cueVideoById(track.videoId, track.suggestedCue || 0);
        playerBRef.current.pause();
      } else {
        createYTPlayer('deck-b-player', track.videoId, {
          onReady: (wrapper) => {
            playerBRef.current = wrapper;
            wrapper.setVolume(85);
            wrapper.pause();
          },
          onStateChange: (state) => {
            if (state === 1) {
              setEmbedErrorB(false);
              setDeckB(prev => ({ ...prev, isPlaying: true }));
            } else if (state === 2 || state === 0 || state === 5) {
              setDeckB(prev => ({ ...prev, isPlaying: false }));
            }
          },
          onError: () => setEmbedErrorB(true),
        });
      }
      logMixAction(`Loaded Track: ${track.title}`, 'B');
    }
  };

  // Global Keyboard Shortcuts Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger when user is typing in an input
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      const key = e.key.toLowerCase();

      // Deck A Transport
      if (key === 'w') {
        e.preventDefault();
        handlePlayPause('A');
      } else if (key === 'q') {
        e.preventDefault();
        handleCue('A');
      } else if (key === 'e') {
        e.preventDefault();
        handleSyncBpm('A');
      } else if (['1', '2', '3', '4'].includes(key)) {
        e.preventDefault();
        handleTriggerCue('A', parseInt(key, 10));
      }

      // Deck B Transport
      else if (key === 'i') {
        e.preventDefault();
        handlePlayPause('B');
      } else if (key === 'u') {
        e.preventDefault();
        handleCue('B');
      } else if (key === 'o') {
        e.preventDefault();
        handleSyncBpm('B');
      } else if (['7', '8', '9', '0'].includes(key)) {
        e.preventDefault();
        const num = key === '0' ? 4 : parseInt(key, 10) - 6;
        handleTriggerCue('B', num);
      }

      // Mixer Crossfader
      else if (key === '[') {
        e.preventDefault();
        setCrossfader(prev => Math.max(-1, prev - 0.1));
      } else if (key === ']') {
        e.preventDefault();
        setCrossfader(prev => Math.min(1, prev + 0.1));
      } else if (key === ' ') {
        e.preventDefault();
        setCrossfader(0);
      }

      // Sampler Sound FX Pads
      else if (key === 'h') {
        audioFx.playAirhorn();
      } else if (key === 'b') {
        audioFx.play808Drop();
      } else if (key === 'n') {
        audioFx.playSiren();
      } else if (key === 't') {
        audioFx.playVinylBrake();
      } else if (key === 'l') {
        audioFx.playLaser();
      } else if (key === 'r') {
        audioFx.playBackspin();
      } else if (key === 's') {
        audioFx.playRaveStab();
      } else if (key === 'm') {
        audioFx.playBeatClick(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  // OpenMix Hardware Controller & Web MIDI Engine
  useEffect(() => {
    const engine = new DjControllerEngine({
      onAction: (action, value) => {
        switch (action) {
          case 'crossfader':
            if (value !== undefined) setCrossfader(Math.max(-1, Math.min(1, value)));
            break;
          case 'masterVolume':
            if (value !== undefined) setMasterVolume(Math.max(0, Math.min(100, value)));
            break;
          case 'deckA_play':
            handlePlayPause('A');
            break;
          case 'deckA_cue':
            handleCue('A');
            break;
          case 'deckA_sync':
            handleSyncBpm('A');
            break;
          case 'deckA_volume':
            if (value !== undefined) setDeckA(prev => ({ ...prev, volume: value }));
            break;
          case 'deckA_filter':
            if (value !== undefined) setDeckA(prev => ({ ...prev, filter: value }));
            break;
          case 'deckA_hotcue1':
            handleTriggerCue('A', 1);
            break;
          case 'deckA_hotcue2':
            handleTriggerCue('A', 2);
            break;
          case 'deckA_hotcue3':
            handleTriggerCue('A', 3);
            break;
          case 'deckA_hotcue4':
            handleTriggerCue('A', 4);
            break;
          case 'deckB_play':
            handlePlayPause('B');
            break;
          case 'deckB_cue':
            handleCue('B');
            break;
          case 'deckB_sync':
            handleSyncBpm('B');
            break;
          case 'deckB_volume':
            if (value !== undefined) setDeckB(prev => ({ ...prev, volume: value }));
            break;
          case 'deckB_filter':
            if (value !== undefined) setDeckB(prev => ({ ...prev, filter: value }));
            break;
          case 'deckB_hotcue1':
            handleTriggerCue('B', 1);
            break;
          case 'deckB_hotcue2':
            handleTriggerCue('B', 2);
            break;
          case 'deckB_hotcue3':
            handleTriggerCue('B', 3);
            break;
          case 'deckB_hotcue4':
            handleTriggerCue('B', 4);
            break;
          case 'fxOn':
            audioFx.toggleFx();
            break;
          case 'fxLevel':
            if (value !== undefined) audioFx.setFxLevel(value);
            break;
          case 'airhorn':
            audioFx.playAirhorn();
            break;
        }
      },
      onDeviceChange: (devs) => {
        setControllerDevices(devs);
      },
      onMidiLearnCaptured: () => {
        setLearningAction(null);
      },
    });

    controllerEngineRef.current = engine;
    engine.init();

    return () => {
      engine.destroy();
    };
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans select-none antialiased">
      {/* Top Header */}
      <Header
        displayMode={displayMode}
        onChangeDisplayMode={setDisplayMode}
        keyA={deckA.track?.key}
        keyB={deckB.track?.key}
        isRecording={isRecording}
        onOpenCrateModal={() => setIsCrateModalOpen(true)}
        onOpenRecordingModal={() => setIsRecordingModalOpen(true)}
        onOpenShortcutsModal={() => setIsShortcutsModalOpen(true)}
        onOpenMidiModal={() => setIsMidiModalOpen(true)}
        connectedControllersCount={controllerDevices.length}
        isMuted={isMuted}
        onToggleMute={() => {
          setIsMuted(!isMuted);
          audioFx.setMute(!isMuted);
        }}
      />

      {/* Main Console Layout */}
      <main className="flex-1 max-w-[1720px] w-full mx-auto p-2 sm:p-2.5 flex flex-col gap-2.5">
        {/* Top Mashup Video Stage: Dual YouTube videos mashed up at the top with Screen blend and CC for Accapella */}
        <TopMashupVideoStage
          trackA={deckA.track}
          trackB={deckB.track}
          currentTimeA={deckA.currentTime}
          currentTimeB={deckB.currentTime}
          isPlayingA={deckA.isPlaying}
          isPlayingB={deckB.isPlaying}
          bpmA={deckA.effectiveBpm}
          bpmB={deckB.effectiveBpm}
          crossfader={crossfader}
          onCrossfaderChange={setCrossfader}
          loopAActive={deckA.loop.active}
          loopBActive={deckB.loop.active}
          displayMode={displayMode}
          onChangeDisplayMode={setDisplayMode}
          embedErrorA={embedErrorA}
          embedErrorB={embedErrorB}
          onPlayPauseA={() => handlePlayPause('A')}
          onPlayPauseB={() => handlePlayPause('B')}
        />

        {/* Dual Decks & Central Master Mixer */}
        <div className="flex flex-col lg:flex-row gap-2.5 items-stretch">
          {/* DECK A */}
          <Deck
            state={deckA}
            oppositeDeckTrack={deckB.track}
            oppositeEffectiveBpm={deckB.effectiveBpm}
            onPlayPause={() => handlePlayPause('A')}
            onCue={() => handleCue('A')}
            onSeek={(secs) => handleSeek('A', secs)}
            onScratch={(delta) => handleScratch('A', delta)}
            onNudge={(dir) => handleNudge('A', dir)}
            onChangePitch={(p) => handleChangePitch('A', p)}
            onSetPitchRange={(rng) => setDeckA(prev => ({ ...prev, pitchRange: rng }))}
            onToggleKeyLock={() => setDeckA(prev => ({ ...prev, keyLock: !prev.keyLock }))}
            onSyncBpm={() => handleSyncBpm('A')}
            onTapBpm={() => handleTapBpm('A')}
            onChangeEQ={(band, val) => setDeckA(prev => ({ ...prev, eq: { ...prev.eq, [band]: val } }))}
            onToggleKill={(band) => setDeckA(prev => ({ ...prev, eqKill: { ...prev.eqKill, [band]: !prev.eqKill[band] } }))}
            onChangeFilter={(val) => setDeckA(prev => ({ ...prev, filter: val }))}
            onTriggerCue={(id) => handleTriggerCue('A', id)}
            onDeleteCue={(id) => handleDeleteCue('A', id)}
            onSetLoop={(beats) => handleSetLoop('A', beats)}
            onToggleLoop={() => handleToggleLoop('A')}
            onHalveLoop={() => handleSetLoop('A', Math.max(0.25, deckA.loop.lengthBeats / 2))}
            onDoubleLoop={() => handleSetLoop('A', Math.min(32, deckA.loop.lengthBeats * 2))}
            onOpenCrateModal={() => setIsCrateModalOpen(true)}
            onLoadTrack={(t) => handleLoadTrackToDeck('A', t)}
            customTracks={customTracks}
            showVideo={false}
          />

          {/* MASTER MIXER CONSOLE */}
          <div className="flex justify-center">
            <MasterMixer
              volumeA={deckA.volume}
              volumeB={deckB.volume}
              masterVolume={masterVolume}
              crossfader={crossfader}
              crossfaderCurve={crossfaderCurve}
              pflA={deckA.pfl}
              pflB={deckB.pfl}
              isDeckAPlaying={deckA.isPlaying}
              isDeckBPlaying={deckB.isPlaying}
              onChangeVolumeA={(vol) => setDeckA(prev => ({ ...prev, volume: vol }))}
              onChangeVolumeB={(vol) => setDeckB(prev => ({ ...prev, volume: vol }))}
              onChangeMasterVolume={setMasterVolume}
              onChangeCrossfader={setCrossfader}
              onChangeCurve={setCrossfaderCurve}
              onTogglePflA={() => setDeckA(prev => ({ ...prev, pfl: !prev.pfl }))}
              onTogglePflB={() => setDeckB(prev => ({ ...prev, pfl: !prev.pfl }))}
              onStartAutoTransition={handleStartAutoTransition}
              isAutoTransitioning={isAutoTransitioning}
              autoTransitionProgress={autoTransitionProgress}
            />
          </div>

          {/* DECK B */}
          <Deck
            state={deckB}
            oppositeDeckTrack={deckA.track}
            oppositeEffectiveBpm={deckA.effectiveBpm}
            onPlayPause={() => handlePlayPause('B')}
            onCue={() => handleCue('B')}
            onSeek={(secs) => handleSeek('B', secs)}
            onScratch={(delta) => handleScratch('B', delta)}
            onNudge={(dir) => handleNudge('B', dir)}
            onChangePitch={(p) => handleChangePitch('B', p)}
            onSetPitchRange={(rng) => setDeckB(prev => ({ ...prev, pitchRange: rng }))}
            onToggleKeyLock={() => setDeckB(prev => ({ ...prev, keyLock: !prev.keyLock }))}
            onSyncBpm={() => handleSyncBpm('B')}
            onTapBpm={() => handleTapBpm('B')}
            onChangeEQ={(band, val) => setDeckB(prev => ({ ...prev, eq: { ...prev.eq, [band]: val } }))}
            onToggleKill={(band) => setDeckB(prev => ({ ...prev, eqKill: { ...prev.eqKill, [band]: !prev.eqKill[band] } }))}
            onChangeFilter={(val) => setDeckB(prev => ({ ...prev, filter: val }))}
            onTriggerCue={(id) => handleTriggerCue('B', id)}
            onDeleteCue={(id) => handleDeleteCue('B', id)}
            onSetLoop={(beats) => handleSetLoop('B', beats)}
            onToggleLoop={() => handleToggleLoop('B')}
            onHalveLoop={() => handleSetLoop('B', Math.max(0.25, deckB.loop.lengthBeats / 2))}
            onDoubleLoop={() => handleSetLoop('B', Math.min(32, deckB.loop.lengthBeats * 2))}
            onOpenCrateModal={() => setIsCrateModalOpen(true)}
            onLoadTrack={(t) => handleLoadTrackToDeck('B', t)}
            customTracks={customTracks}
            showVideo={false}
          />
        </div>

        {/* OpenMix Pro DJ DSP Multi-Effects Unit */}
        <OpenMixFxRack effectiveBpm={(deckA.effectiveBpm + deckB.effectiveBpm) / 2} />

        {/* Sampler Sound FX Performance Bank */}
        <SamplerPads />
      </main>

      {/* Modals */}
      <MidiControllerModal
        isOpen={isMidiModalOpen}
        onClose={() => setIsMidiModalOpen(false)}
        devices={controllerDevices}
        onStartLearn={(action) => {
          setLearningAction(action);
          controllerEngineRef.current?.startLearn(action);
        }}
        learningAction={learningAction}
        onResetMappings={() => controllerEngineRef.current?.resetCustomMappings()}
      />

      <CrateModal
        isOpen={isCrateModalOpen}
        onClose={() => setIsCrateModalOpen(false)}
        onLoadTrackToDeck={handleLoadTrackToDeck}
        onLoadMashupPreset={handleLoadMashupPreset}
        onAddCustomTrack={(t) => setCustomTracks(prev => [t, ...prev])}
        customTracks={customTracks}
      />

      <RecordingModal
        isOpen={isRecordingModalOpen}
        onClose={() => setIsRecordingModalOpen(false)}
        isRecording={isRecording}
        events={mixEvents}
        deckA={deckA}
        deckB={deckB}
        onToggleRecording={() => setIsRecording(!isRecording)}
        onClearHistory={() => setMixEvents([])}
      />

      <ShortcutsModal
        isOpen={isShortcutsModalOpen}
        onClose={() => setIsShortcutsModalOpen(false)}
      />
    </div>
  );
}
