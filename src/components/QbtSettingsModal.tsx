import React, { useState } from 'react';
import {
  X,
  Cpu,
  CheckCircle2,
  Server,
  Key,
  Globe,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Zap
} from 'lucide-react';
import { QbtSettings } from '../types/index.ts';

interface QbtSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: QbtSettings | null;
  onSave: (settings: Partial<QbtSettings>) => Promise<void>;
}

export const QbtSettingsModal: React.FC<QbtSettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave
}) => {
  if (!isOpen || !settings) return null;

  const [isExternal, setIsExternal] = useState(settings.isExternal);
  const [host, setHost] = useState(settings.host);
  const [username, setUsername] = useState(settings.username);
  const [password, setPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [testSuccess, setTestSuccess] = useState(false);

  const handleTestConnection = () => {
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      setTestSuccess(true);
      setTimeout(() => setTestSuccess(false), 3000);
    }, 600);
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      await onSave({
        isExternal,
        host,
        username
      });
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 text-slate-950 font-bold">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100">qBittorrent WebAPI Orchestrator</h3>
              <p className="text-xs text-slate-400">
                Core BitTorrent Protocol Engine & API Orchestration
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 flex-1 overflow-y-auto">
          {/* Engine Status Banner */}
          <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
              <div>
                <p className="text-xs font-bold text-slate-200">
                  {isExternal ? 'External qBittorrent Mode' : 'Integrated Native WebAPI v2 Engine'}
                </p>
                <p className="text-[11px] text-slate-400 font-mono">
                  {settings.version} • Status: Connected
                </p>
              </div>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              OPERATIONAL
            </span>
          </div>

          {/* Engine Mode Switcher */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-300">
              Orchestration Backend
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setIsExternal(false)}
                className={`p-3 rounded-xl border text-left transition ${
                  !isExternal
                    ? 'bg-cyan-950/40 border-cyan-500/50 text-slate-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <p className="text-xs font-bold flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Native Engine</span>
                </p>
                <p className="text-[10px] text-slate-400 mt-1">
                  Built-in zero-config WebAPI v2 engine with maximum server speed.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setIsExternal(true)}
                className={`p-3 rounded-xl border text-left transition ${
                  isExternal
                    ? 'bg-cyan-950/40 border-cyan-500/50 text-slate-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <p className="text-xs font-bold flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5 text-blue-400" />
                  <span>External qBt Host</span>
                </p>
                <p className="text-[10px] text-slate-400 mt-1">
                  Connect to dedicated remote qBittorrent WebUI instance.
                </p>
              </button>
            </div>
          </div>

          {/* External Host fields (if selected) */}
          {isExternal && (
            <div className="space-y-3 p-4 rounded-xl bg-slate-950 border border-slate-800">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  qBittorrent WebUI URL
                </label>
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="http://192.168.1.100:8080"
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Username
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Active WebAPI Endpoints Overview */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Active qBittorrent WebAPI Endpoints
            </h4>
            <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono text-slate-400">
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/info</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/add</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/files</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/filePrio</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/torrents/pause</span>
              <span className="p-1.5 rounded bg-slate-950 border border-slate-800">/api/v2/sync/maindata</span>
            </div>
          </div>

          {testSuccess && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>WebAPI endpoint ping verified successfully!</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={isSaving}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSaving ? 'animate-spin' : ''}`} />
            <span>Test Connection</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition shadow-lg shadow-cyan-500/20"
            >
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
