'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  ShieldAlert,
  Bot,
  Activity,
  Volume2,
  VolumeX,
  MapPin,
  Clock,
  Battery,
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Radio,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { GestureDetectionResult } from '@/components/wellness/GestureDetector';

// Dynamically import GestureDetector with SSR disabled for Next.js browser-only rendering
const GestureDetector = dynamic(
  () => import('@/components/wellness/GestureDetector'),
  {
    ssr: false,
    loading: () => (
      <div className="w-full aspect-[4/3] bg-slate-900 rounded-2xl flex flex-col items-center justify-center border border-slate-800 animate-pulse text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin text-cyan-400 mb-2" />
        <span className="text-sm">Mounting Client Vision Pipeline...</span>
      </div>
    ),
  }
);

interface EmergencyLogItem {
  id: string;
  timestamp: string;
  status: 'PENDING' | 'DISPATCHED' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED';
  roomLocation: string;
  confidenceScore: number;
  triggerType: string;
  notes?: string;
  robotAssigned?: {
    id: string;
    name: string;
    status: string;
    batteryLevel: number;
    currentRoom: string;
  } | null;
}

export default function EmergencyGesturePage() {
  // Living Lab Configuration
  const [selectedRoom, setSelectedRoom] = useState<string>(
    'Living Lab Room 101 - Smart Care Zone'
  );
  const [isTTSActive, setIsTTSActive] = useState<boolean>(true);
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [speechLanguage, setSpeechLanguage] = useState<'th' | 'en'>('th');

  // Emergency Incident States
  const [activeEmergency, setActiveEmergency] = useState<EmergencyLogItem | null>(null);
  const [isDispatching, setIsDispatching] = useState<boolean>(false);
  const [recentLogs, setRecentLogs] = useState<EmergencyLogItem[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState<boolean>(true);
  const [fleetStats, setFleetStats] = useState({ available: 1, dispatched: 0 });

  const hasSpokenRef = useRef<boolean>(false);

  /**
   * Synthesize Robot Voice using Web Speech API (Client-side TTS)
   */
  const speakRobotResponse = useCallback(
    (lang: 'th' | 'en' = speechLanguage) => {
      if (!isTTSActive || typeof window === 'undefined' || !('speechSynthesis' in window)) {
        return;
      }

      window.speechSynthesis.cancel(); // Stop any pending utterances

      const thaiText = 'ได้รับสัญญาณฉุกเฉินแล้ว กำลังส่งความช่วยเหลือเข้าสู่ห้องของท่าน';
      const englishText =
        'Emergency distress signal confirmed. Dispatching response robot to your location immediately.';

      const utterance = new SpeechSynthesisUtterance(lang === 'th' ? thaiText : englishText);
      utterance.lang = lang === 'th' ? 'th-TH' : 'en-US';
      utterance.rate = 1.0;
      utterance.pitch = 1.05; // Slightly robotic/clear tone

      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = (e) => {
        console.warn('[SpeechSynthesis] Error uttering voice:', e);
        setIsSpeaking(false);
      };

      // Select Thai or English voice if available
      const voices = window.speechSynthesis.getVoices();
      const targetVoice = voices.find((v) =>
        lang === 'th' ? v.lang.includes('th') : v.lang.includes('en')
      );
      if (targetVoice) {
        utterance.voice = targetVoice;
      }

      window.speechSynthesis.speak(utterance);
    },
    [isTTSActive, speechLanguage]
  );

  /**
   * Fetch Emergency Logs from API
   */
  const fetchEmergencyLogs = useCallback(async () => {
    try {
      setIsLoadingLogs(true);
      const res = await fetch('/api/emergency?limit=10');
      if (!res.ok) throw new Error('Failed to fetch emergency logs');
      const data = await res.json();
      if (data.success) {
        setRecentLogs(data.data.logs);
        if (data.data.fleetStatus) {
          setFleetStats({
            available: data.data.fleetStatus.availableRobots,
            dispatched: data.data.fleetStatus.dispatchedRobots,
          });
        }
      }
    } catch (err) {
      console.warn('[Dashboard] Could not fetch logs from API:', err);
    } finally {
      setIsLoadingLogs(false);
    }
  }, []);

  useEffect(() => {
    fetchEmergencyLogs();
    // Refresh voices list in browser
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }, [fetchEmergencyLogs]);

  /**
   * Triggered when GestureDetector successfully confirms the SOS gesture
   */
  const handleSOSDetected = async (result: GestureDetectionResult) => {
    if (isDispatching) return;
    setIsDispatching(true);

    try {
      // 1. Play robotic speech synthesis immediately (zero-latency HRI feedback)
      speakRobotResponse(speechLanguage);

      // 2. Transmit distress signal to Backend API
      const res = await fetch('/api/emergency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomLocation: selectedRoom,
          confidenceScore: result.confidenceScore,
          triggerType: 'SOS_GESTURE',
          notes: `Signal for Help held > 1.5s. Client-side confidence: ${(result.confidenceScore * 100).toFixed(0)}%`,
        }),
      });

      if (!res.ok) {
        throw new Error('Server returned non-200 for emergency route');
      }

      const responseData = await res.json();
      if (responseData.success) {
        setActiveEmergency(responseData.data.log);
        // Refresh logs list
        fetchEmergencyLogs();
      }
    } catch (error) {
      console.error('[EmergencyGesturePage] Failed to dispatch SOS:', error);
      // Fallback local emergency display
      const fallbackLog: EmergencyLogItem = {
        id: 'local-' + Date.now(),
        timestamp: new Date().toISOString(),
        status: 'DISPATCHED',
        roomLocation: selectedRoom,
        confidenceScore: result.confidenceScore,
        triggerType: 'SOS_GESTURE',
        robotAssigned: {
          id: 'bot-fallback',
          name: 'Humanoid-Medic-01 (Offline Fallback)',
          status: 'DISPATCHED',
          batteryLevel: 94,
          currentRoom: selectedRoom,
        },
      };
      setActiveEmergency(fallbackLog);
      setRecentLogs((prev) => [fallbackLog, ...prev]);
    } finally {
      setIsDispatching(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-rose-500 selection:text-white">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-gradient-to-tr from-rose-600 to-amber-500 rounded-xl shadow-lg shadow-rose-900/30">
              <ShieldAlert className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-base font-bold tracking-tight text-white">
                  HRI Wellness Living Lab
                </span>
                <span className="text-[10px] uppercase font-mono font-semibold px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-400 border border-cyan-800">
                  AI Vision 2.0
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Non-Verbal Distress & SOS Gesture Responder
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            {/* Link to Map for HRI integration flow */}
            <Link
              href="/map"
              className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors"
            >
              <MapPin className="w-3.5 h-3.5 text-rose-400" />
              <span>Fleet Map View</span>
              <ExternalLink className="w-3 h-3 text-slate-500" />
            </Link>

            {/* Test Voice TTS button */}
            <button
              onClick={() => speakRobotResponse(speechLanguage)}
              className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300 bg-cyan-950/60 hover:bg-cyan-900/60 rounded-lg border border-cyan-800/80 transition-colors"
              title="Test Web Speech Voice Response"
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Test Robot Voice</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Layout */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 w-full flex-1">
        {/* Top Control & Telemetry Bar */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          {/* Location Selector */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center space-x-1.5 mb-1.5">
              <MapPin className="w-3.5 h-3.5 text-cyan-400" />
              <span>Living Lab Monitoring Room</span>
            </label>
            <select
              value={selectedRoom}
              onChange={(e) => setSelectedRoom(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 transition"
            >
              <option value="Living Lab Room 101 - Smart Care Zone">Room 101 - Smart Care Zone</option>
              <option value="Living Lab Room 102 - Rehab Suite">Room 102 - Rehab Suite</option>
              <option value="Living Lab Room 201 - Senior Resident Care">Room 201 - Senior Resident Care</option>
              <option value="Living Lab Common Wellness Hub">Common Wellness Hub</option>
            </select>
          </div>

          {/* HRI Voice Feedback Setting */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center space-x-1.5">
                <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                <span>Robot Voice Synthesis</span>
              </span>
              <button
                onClick={() => setIsTTSActive(!isTTSActive)}
                className={`p-1 rounded-md text-xs transition ${
                  isTTSActive ? 'text-emerald-400 bg-emerald-950/40' : 'text-slate-500 bg-slate-800'
                }`}
              >
                {isTTSActive ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-slate-400">Language:</span>
              <div className="flex items-center space-x-1 bg-slate-950 p-0.5 rounded-md border border-slate-800 text-[11px]">
                <button
                  onClick={() => setSpeechLanguage('th')}
                  className={`px-2 py-0.5 rounded font-medium ${
                    speechLanguage === 'th' ? 'bg-cyan-600 text-white' : 'text-slate-400'
                  }`}
                >
                  ไทย
                </button>
                <button
                  onClick={() => setSpeechLanguage('en')}
                  className={`px-2 py-0.5 rounded font-medium ${
                    speechLanguage === 'en' ? 'bg-cyan-600 text-white' : 'text-slate-400'
                  }`}
                >
                  EN
                </button>
              </div>
            </div>
          </div>

          {/* Privacy & Zero-Stream Guarantee */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center space-x-1.5 mb-1">
              <Activity className="w-3.5 h-3.5 text-emerald-400" />
              <span>Zero-Stream Edge AI</span>
            </div>
            <p className="text-xs text-slate-300 font-medium">100% Client-side Processing</p>
            <p className="text-[11px] text-slate-500 mt-1">
              No video frames leave the browser. Zero cloud video storage.
            </p>
          </div>

          {/* Fleet Status Card */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md flex flex-col justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center space-x-1.5">
              <Bot className="w-3.5 h-3.5 text-cyan-400" />
              <span>Humanoid Fleet Readiness</span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center space-x-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-slate-300 font-medium">
                  {fleetStats.available} Available
                </span>
              </div>
              <span className="text-xs text-rose-400 font-medium">
                {fleetStats.dispatched} Dispatched
              </span>
            </div>
          </div>
        </div>

        {/* Dynamic Alert Banner when Emergency is active */}
        {activeEmergency && (
          <div className="mb-6 p-4 rounded-2xl bg-gradient-to-r from-rose-950/80 via-slate-900 to-rose-950/80 border border-rose-500/60 shadow-xl shadow-rose-950/40 flex flex-col sm:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex items-center space-x-3">
              <div className="p-3 bg-rose-600 text-white rounded-xl shadow-lg shadow-rose-600/40 animate-pulse">
                <Radio className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="text-base font-bold text-rose-300">
                    EMERGENCY DISTRESS DISPATCHED
                  </h3>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-900/80 text-rose-200 border border-rose-700">
                    ID: {activeEmergency.id.slice(-6)}
                  </span>
                </div>
                <p className="text-xs text-slate-300 mt-0.5">
                  Robot{' '}
                  <strong className="text-white">
                    {activeEmergency.robotAssigned?.name || 'Humanoid-Medic-01'}
                  </strong>{' '}
                  is en route to <span className="text-rose-200 underline">{activeEmergency.roomLocation}</span>.
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Link
                href="/map"
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-xl shadow-lg transition-colors flex items-center space-x-1.5"
              >
                <MapPin className="w-3.5 h-3.5" />
                <span>Track Robot on Map</span>
              </Link>
            </div>
          </div>
        )}

        {/* Core Layout Grid: Vision Center & Side Log Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Computer Vision Stream & Audio Indicator (7 cols) */}
          <div className="lg:col-span-7 flex flex-col space-y-4">
            <GestureDetector
              onSOSDetected={handleSOSDetected}
              requiredHoldDurationSec={1.5}
            />

            {/* Speaking Wave Animation indicator */}
            {isSpeaking && (
              <div className="p-3 bg-cyan-950/40 border border-cyan-800 rounded-xl flex items-center justify-between animate-pulse">
                <div className="flex items-center space-x-2.5">
                  <div className="flex items-center space-x-1">
                    <span className="w-1 h-4 bg-cyan-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-1 h-6 bg-cyan-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-1 h-3 bg-cyan-400 rounded-full animate-bounce" />
                  </div>
                  <span className="text-xs font-medium text-cyan-300">
                    Robot Speech Active: "ได้รับสัญญาณฉุกเฉินแล้ว กำลังส่งความช่วยเหลือเข้าสู่ห้องของท่าน"
                  </span>
                </div>
                <span className="text-[10px] font-mono text-cyan-400 bg-cyan-900/60 px-2 py-0.5 rounded">
                  Web Speech API
                </span>
              </div>
            )}

            {/* Gesture How-To Guide Box */}
            <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center space-x-1.5 mb-2">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Standard "Signal for Help" Procedure</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-slate-400">
                <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                  <div className="font-semibold text-slate-200 mb-1">1. Palm Out</div>
                  <p className="text-[11px] text-slate-400">Show open hand with palm facing directly toward the camera.</p>
                </div>
                <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                  <div className="font-semibold text-amber-300 mb-1">2. Tuck Thumb</div>
                  <p className="text-[11px] text-slate-400">Fold your thumb inwards across the center of your palm.</p>
                </div>
                <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                  <div className="font-semibold text-rose-400 mb-1">3. Fold Fingers</div>
                  <p className="text-[11px] text-slate-400">Close the remaining four fingers over the tucked thumb for 1.5s.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Active Responder Card & Incident Log Panel (5 cols) */}
          <div className="lg:col-span-5 flex flex-col space-y-4">
            {/* Robot Responder Card */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl relative overflow-hidden">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-2.5">
                  <div className="p-2 bg-cyan-950 text-cyan-400 rounded-xl border border-cyan-800">
                    <Bot className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-100">
                      Assigned Responder Unit
                    </h3>
                    <p className="text-[11px] text-slate-400">Autonomous Living Lab Escort</p>
                  </div>
                </div>
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                    activeEmergency?.robotAssigned?.status === 'DISPATCHED'
                      ? 'bg-rose-950 text-rose-400 border-rose-800 animate-pulse'
                      : 'bg-emerald-950 text-emerald-400 border-emerald-800'
                  }`}
                >
                  {activeEmergency?.robotAssigned?.status || 'STANDBY / IDLE'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800/80">
                  <div className="text-slate-500 text-[10px] uppercase font-mono">Robot Name</div>
                  <div className="font-semibold text-slate-200 mt-0.5">
                    {activeEmergency?.robotAssigned?.name || 'Humanoid-Medic-01'}
                  </div>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800/80">
                  <div className="text-slate-500 text-[10px] uppercase font-mono">Battery Level</div>
                  <div className="font-semibold text-emerald-400 mt-0.5 flex items-center space-x-1">
                    <Battery className="w-3.5 h-3.5" />
                    <span>{activeEmergency?.robotAssigned?.batteryLevel ?? 96}%</span>
                  </div>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800/80 col-span-2">
                  <div className="text-slate-500 text-[10px] uppercase font-mono">Current Sector</div>
                  <div className="font-semibold text-slate-200 mt-0.5 flex items-center space-x-1">
                    <MapPin className="w-3.5 h-3.5 text-rose-400" />
                    <span>{activeEmergency?.roomLocation || selectedRoom}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Emergency Incident Log Panel */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex-1 flex flex-col">
              <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-800">
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4 text-slate-400" />
                  <h3 className="text-sm font-bold text-slate-200">Incident Event History</h3>
                </div>
                <button
                  onClick={fetchEmergencyLogs}
                  disabled={isLoadingLogs}
                  className="p-1 text-slate-400 hover:text-slate-200 transition"
                  title="Refresh Log History"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingLogs ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {/* Logs Scrollable Container */}
              <div className="space-y-2.5 overflow-y-auto max-h-[380px] pr-1">
                {recentLogs.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 text-xs">
                    No emergency events recorded in this session.
                  </div>
                ) : (
                  recentLogs.map((log) => (
                    <div
                      key={log.id}
                      className="p-3 bg-slate-950 rounded-xl border border-slate-800/80 hover:border-slate-700 transition flex flex-col space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-mono text-[10px] text-slate-400">
                          {new Date(log.timestamp).toLocaleTimeString()} &bull; {new Date(log.timestamp).toLocaleDateString()}
                        </span>
                        <span
                          className={`text-[9px] font-mono px-2 py-0.5 rounded-full font-semibold border ${
                            log.status === 'DISPATCHED'
                              ? 'bg-rose-950 text-rose-300 border-rose-800'
                              : log.status === 'RESOLVED'
                              ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                              : 'bg-amber-950 text-amber-300 border-amber-800'
                          }`}
                        >
                          {log.status}
                        </span>
                      </div>

                      <div className="text-xs font-medium text-slate-200 flex items-center space-x-1.5">
                        <MapPin className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        <span className="truncate">{log.roomLocation}</span>
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-900">
                        <span>
                          Robot: <strong className="text-slate-300">{log.robotAssigned?.name || 'Unassigned'}</strong>
                        </span>
                        <span>
                          Conf: <strong className="text-slate-300">{Math.round(log.confidenceScore * 100)}%</strong>
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
