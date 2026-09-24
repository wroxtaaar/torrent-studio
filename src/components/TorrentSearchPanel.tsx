import React, { useMemo, useState } from 'react';
import {
  Search,
  Loader2,
  Download,
  ExternalLink,
  Users,
  Database,
  AlertCircle,
  SlidersHorizontal
} from 'lucide-react';
import { api, TorrentSearchResult } from '../api/client.ts';
import { formatBytes } from '../utils/formatters.ts';

interface TorrentSearchPanelProps {
  onAdd: (source: string) => void;
}

function formatPublished(value?: string) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const TorrentSearchPanel: React.FC<TorrentSearchPanelProps> = ({ onAdd }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TorrentSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [sortBy, setSortBy] = useState<'time' | 'size' | 'seeds'>('time');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');

  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault();

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError('Enter at least 2 characters to search.');
      setResults([]);
      setSearched(false);
      return;
    }

    try {
      setIsSearching(true);
      setError('');
      const data = await api.searchTorrents(trimmed, 50);
      setResults(data);
      setSearched(true);

      if (data.length === 0) {
        setError('No torrent results were returned by your configured indexers.');
      }
    } catch (err: any) {
      setResults([]);
      setSearched(true);
      setError(err?.message || 'Torrent search failed.');
    } finally {
      setIsSearching(false);
    }
  };

  const sortedResults = useMemo(() => {
    const sorted = [...results];

    sorted.sort((a, b) => {
      let aValue = 0;
      let bValue = 0;

      if (sortBy === 'time') {
        aValue = a.publishDate ? new Date(a.publishDate).getTime() : 0;
        bValue = b.publishDate ? new Date(b.publishDate).getTime() : 0;
      } else if (sortBy === 'size') {
        aValue = Number(a.size) || 0;
        bValue = Number(b.size) || 0;
      } else {
        aValue = Number(a.seeders) || 0;
        bValue = Number(b.seeders) || 0;
      }

      const comparison = aValue - bValue;
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [results, sortBy, sortDirection]);

  return (
    <div className="space-y-4">
      <div className="p-4 sm:p-5 rounded-2xl bg-slate-900 border border-slate-800">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Search className="w-5 h-5 text-cyan-400" />
            Search Torrents
          </h2>
          <p className="text-xs text-slate-400">
            Search the torrent indexers configured in your server-side search provider.
          </p>
        </div>

        <form onSubmit={runSearch} className="mt-4 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (error) setError('');
              }}
              placeholder="Search movies, TV, music, software..."
              className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/20"
            />
          </div>

          <button
            type="submit"
            disabled={isSearching}
            className="px-4 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 text-xs font-bold flex items-center justify-center gap-2 transition"
          >
            {isSearching ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Searching...
              </>
            ) : (
              <>
                <Search className="w-4 h-4" />
                Search
              </>
            )}
          </button>
        </form>
      </div>

      {error && (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">{error}</div>
            {error.toLowerCase().includes('prowlarr') || error.toLowerCase().includes('configured') ? (
              <div className="text-amber-400/80 mt-1">
                Configure your Prowlarr API key in the VPS .env file and make sure at least one torrent indexer is enabled.
              </div>
            ) : null}
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
            <div className="text-xs text-slate-400">
              {results.length} result{results.length === 1 ? '' : 's'}
            </div>

            <div className="flex items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5">
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'time' | 'size' | 'seeds')}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 focus:outline-none focus:border-cyan-500"
                  title="Sort search results"
                >
                  <option value="time">Time</option>
                  <option value="size">Size</option>
                  <option value="seeds">Seeds</option>
                </select>
              </div>

              <button
                type="button"
                onClick={() => setSortDirection(prev => prev === 'desc' ? 'asc' : 'desc')}
                className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:border-slate-700 transition"
                title={sortDirection === 'desc' ? 'Descending' : 'Ascending'}
              >
                {sortDirection === 'desc' ? '↓' : '↑'}
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900 divide-y divide-slate-800/80">
            {sortedResults.map((result, index) => (
              <div
                key={result.guid || result.infoHash || (result.title + '-' + index)}
                className="p-4 hover:bg-slate-900/80 transition"
              >
                <div className="flex flex-col lg:flex-row lg:items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 shrink-0">
                        <Database className="w-4 h-4 text-cyan-400" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-slate-100 break-words">
                          {result.title}
                        </h3>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px] text-slate-500">
                          <span>{result.indexer || 'Unknown indexer'}</span>
                          <span>{formatPublished(result.publishDate)}</span>
                          {result.protocol && <span className="uppercase">{result.protocol}</span>}
                          {result.infoHash && (
                            <span className="font-mono truncate max-w-[220px]" title={result.infoHash}>
                              {result.infoHash}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-slate-400">
                      <span className="font-mono">{formatBytes(result.size)}</span>
                      <span className="flex items-center gap-1 text-emerald-400">
                        <Users className="w-3.5 h-3.5" />
                        {result.seeders} seeders
                      </span>
                      <span className="text-slate-500">{result.leechers} leechers</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {result.infoUrl && (
                      <a
                        href={result.infoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition"
                        title="Open result information"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}

                    <button
                      type="button"
                      disabled={!result.sourceUrl}
                      onClick={() => result.sourceUrl && onAdd(result.sourceUrl)}
                      className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-bold flex items-center gap-1.5 transition"
                    >
                      <Download className="w-4 h-4" />
                      Add
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isSearching && searched && results.length === 0 && !error && (
        <div className="py-14 text-center rounded-2xl bg-slate-900 border border-slate-800">
          <Search className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-slate-300">No results</h3>
          <p className="text-xs text-slate-500 mt-1">
            Try a broader search term or enable more torrent indexers.
          </p>
        </div>
      )}
    </div>
  );
};
