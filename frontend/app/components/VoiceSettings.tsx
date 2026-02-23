/**
 * VoiceSettings.tsx
 *
 * Voice configuration panel for campaigns.
 * Allows users to:
 *   - Select voice model & language
 *   - Configure TTS settings (speed, emotion)
 *   - Set voicemail behavior
 *   - Preview voice output
 *   - Monitor voice quality
 */

"use client";

import React, { useState, useEffect } from "react";

interface VoiceConfig {
  voice_model: string;
  language: string;
  speech_rate: number; // 0.5 - 2.0
  emotion: "neutral" | "enthusiastic" | "professional" | "friendly";
  voicemail_enabled: boolean;
  voicemail_message: string;
  max_call_duration: number; // seconds
  retry_failed_calls: boolean;
  retry_count: number;
}

interface AvailableVoice {
  id: string;
  name: string;
  language: string;
  gender: "male" | "female" | "neutral";
}

interface VoiceSettingsProps {
  campaignId: string;
  onSave: (config: VoiceConfig) => Promise<void>;
}

export const VoiceSettings: React.FC<VoiceSettingsProps> = ({ campaignId, onSave }) => {
  const [config, setConfig] = useState<VoiceConfig>({
    voice_model: "default",
    language: "en-US",
    speech_rate: 1.0,
    emotion: "professional",
    voicemail_enabled: true,
    voicemail_message: "We have an exciting opportunity for your organization. Please call us back at your earliest convenience.",
    max_call_duration: 300, // 5 minutes
    retry_failed_calls: true,
    retry_count: 2,
  });

  const [availableVoices, setAvailableVoices] = useState<AvailableVoice[]>([]);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Fetch available voices
  useEffect(() => {
    const fetchVoices = async () => {
      try {
        // TODO: Call actual API endpoint
        const mockVoices: AvailableVoice[] = [
          { id: "en-US-Neural2-A", name: "Aria (Neural)", language: "en-US", gender: "female" },
          { id: "en-US-Neural2-C", name: "Liam (Neural)", language: "en-US", gender: "male" },
          { id: "ta-IN-Standard-B", name: "Leela (Tamil)", language: "ta-IN", gender: "female" },
          { id: "hi-IN-Standard-A", name: "Aakash (Hindi)", language: "hi-IN", gender: "male" },
        ];
        setAvailableVoices(mockVoices);
      } catch (error) {
        console.error("[VoiceSettings] Error fetching voices:", error);
      }
    };

    fetchVoices();
  }, []);

  const handlePreview = async () => {
    setIsPreviewPlaying(true);
    try {
      // TODO: Call preview endpoint
      // const response = await fetch(`/api/v1/voice/preview`, {
      //   method: "POST",
      //   body: JSON.stringify({
      //     text: "Hello, we have an exciting opportunity for your organization.",
      //     voice: config.voice_model,
      //     language: config.language,
      //     speech_rate: config.speech_rate,
      //   }),
      // });
      // const audio = await response.blob();
      // Play audio...
      console.log("[VoiceSettings] Preview would play with config:", config);
    } catch (error) {
      console.error("[VoiceSettings] Preview error:", error);
    } finally {
      setIsPreviewPlaying(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus("idle");

    try {
      await onSave(config);
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (error) {
      console.error("[VoiceSettings] Save error:", error);
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-6">
      <h3 className="text-lg font-bold">Voice Configuration</h3>

      {/* Voice Selection */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Voice Model
          </label>
          <select
            value={config.voice_model}
            onChange={(e) => setConfig({ ...config, voice_model: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            {availableVoices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} ({voice.gender})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Language
          </label>
          <select
            value={config.language}
            onChange={(e) => setConfig({ ...config, language: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="ta-IN">Tamil (India)</option>
            <option value="hi-IN">Hindi (India)</option>
            <option value="te-IN">Telugu (India)</option>
            <option value="kn-IN">Kannada (India)</option>
            <option value="ml-IN">Malayalam (India)</option>
            <option value="es-ES">Spanish (Spain)</option>
            <option value="fr-FR">French (France)</option>
            <option value="de-DE">German</option>
            <option value="ja-JP">Japanese</option>
          </select>
        </div>
      </div>

      {/* Voice Characteristics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Speech Rate: {config.speech_rate.toFixed(1)}x
          </label>
          <input
            type="range"
            min="0.5"
            max="2.0"
            step="0.1"
            value={config.speech_rate}
            onChange={(e) => setConfig({ ...config, speech_rate: parseFloat(e.target.value) })}
            className="w-full"
          />
          <p className="text-xs text-gray-600 mt-1">Slower (0.5) → Normal (1.0) → Faster (2.0)</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Tone / Emotion
          </label>
          <select
            value={config.emotion}
            onChange={(e) => setConfig({ ...config, emotion: e.target.value as any })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="neutral">Neutral / Formal</option>
            <option value="professional">Professional</option>
            <option value="friendly">Friendly / Warm</option>
            <option value="enthusiastic">Enthusiastic</option>
          </select>
        </div>
      </div>

      {/* Voicemail Settings */}
      <div className="border-t pt-4">
        <label className="flex items-center gap-2 mb-3">
          <input
            type="checkbox"
            checked={config.voicemail_enabled}
            onChange={(e) => setConfig({ ...config, voicemail_enabled: e.target.checked })}
            className="w-4 h-4 rounded border-gray-300"
          />
          <span className="text-sm font-medium text-gray-700">Enable Voicemail Support</span>
        </label>

        {config.voicemail_enabled && (
          <textarea
            value={config.voicemail_message}
            onChange={(e) => setConfig({ ...config, voicemail_message: e.target.value })}
            placeholder="Voicemail message..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            rows={3}
          />
        )}
      </div>

      {/* Call Settings */}
      <div className="border-t pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Max Call Duration (seconds)
          </label>
          <input
            type="number"
            value={config.max_call_duration}
            onChange={(e) => setConfig({ ...config, max_call_duration: parseInt(e.target.value) })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Retry Failed Calls
          </label>
          <div className="flex items-center gap-3">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={config.retry_failed_calls}
                onChange={(e) => setConfig({ ...config, retry_failed_calls: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="ml-2 text-sm">Enable (max {config.retry_count} attempts)</span>
            </label>
          </div>
        </div>
      </div>

      {/* Preview & Actions */}
      <div className="border-t pt-4 flex gap-2">
        <button
          onClick={handlePreview}
          disabled={isPreviewPlaying}
          className="px-4 py-2 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 disabled:opacity-50"
        >
          {isPreviewPlaying ? "Playing..." : "🔊 Preview Voice"}
        </button>

        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          {isSaving ? "Saving..." : "✓ Save Settings"}
        </button>

        {saveStatus === "success" && (
          <span className="text-green-600 text-sm self-center">✓ Saved successfully</span>
        )}
        {saveStatus === "error" && (
          <span className="text-red-600 text-sm self-center">✗ Save failed</span>
        )}
      </div>

      {/* Info Box */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-900">
          <strong>Note:</strong> Voice settings will apply to new calls. Language switching during
          calls is controlled by the AI agent and will override these settings if the contact
          requests a different language.
        </p>
      </div>
    </div>
  );
};

export default VoiceSettings;
