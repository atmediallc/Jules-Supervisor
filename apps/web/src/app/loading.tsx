export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading control plane view">
      {/* Top Banner Skeleton */}
      <div className="h-32 rounded-2xl bg-slate-800/40 border border-white/5" />

      {/* KPI Cards Skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-28 rounded-2xl bg-slate-800/30 border border-white/5" />
        ))}
      </div>

      {/* Main Grid Skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 h-72 rounded-2xl bg-slate-800/20 border border-white/5" />
        <div className="h-72 rounded-2xl bg-slate-800/20 border border-white/5" />
      </div>
    </div>
  );
}
