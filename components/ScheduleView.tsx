'use client'

import { RateCard, calcSuppressionPrice } from '@/lib/rates'

function estimateJobValue(job: any, rates: RateCard | null): number {
  if (!rates || !job.location) return 0
  const loc = job.location
  let total = 0
  const scope = job.scope || []
  if (scope.includes('extinguishers')) total += (loc.extinguishers?.length || 0) * rates.extinguisher_inspection
  if (scope.includes('suppression')) {
    for (const sys of (loc.suppression_systems || [])) {
      total += calcSuppressionPrice(sys.category, sys.tank_count, rates)
      total += (sys.fusible_link_count || 0) * rates.fusible_link
      total += (sys.nozzle_count || 0) * rates.metal_blowoff_cap
    }
  }
  if (scope.includes('elights')) {
    const el = loc.emergency_lights?.[0]
    if (el) total += (el.fixture_count || 0) * rates.emergency_light
  }
  return total
}

export default function ScheduleView({
  jobs,
  rates,
  onOpenJob,
}: {
  jobs: any[]
  rates: RateCard | null
  onOpenJob: (id: string) => void
}) {
  if (jobs.length === 0) {
    return (
      <div className="text-center py-16 text-gray-500">
        <div className="text-4xl mb-3 opacity-30">📅</div>
        <div className="text-sm">No upcoming jobs scheduled.</div>
      </div>
    )
  }

  // Group by date
  const grouped: Record<string, any[]> = {}
  for (const job of jobs) {
    const d = job.scheduled_date || 'unscheduled'
    if (!grouped[d]) grouped[d] = []
    grouped[d].push(job)
  }

  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mt-5 mb-3">Upcoming Jobs</div>
      {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([date, dateJobs]) => (
        <div key={date} className="mb-4">
          <div className="text-xs font-semibold text-gray-400 mb-2">
            {date === 'unscheduled' ? 'Unscheduled' : new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          {dateJobs.map(job => {
            const loc = job.location
            const est = estimateJobValue(job, rates)
            const scope = job.scope || []
            const today = new Date().toISOString().split('T')[0]
            const isPast = job.scheduled_date < today
            return (
              <div
                key={job.id}
                onClick={() => onOpenJob(job.id)}
                className={`bg-[#12151c] border rounded-xl p-3.5 mb-2 relative overflow-hidden cursor-pointer active:border-[#e85d26] transition-colors ${
                  isPast ? 'border-red-500/30' : 'border-[#2a3040]'
                }`}
              >
                <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${
                  isPast ? 'bg-red-500' :
                  job.status === 'completed' ? 'bg-gray-600' :
                  'bg-blue-500'
                }`} />
                <div className="flex justify-between items-start mb-1">
                  <div className="text-sm font-bold">{loc?.name || 'Unknown'}</div>
                  <div className="font-mono text-xs text-gray-500">{job.scheduled_time?.slice(0, 5) || ''}</div>
                </div>
                <div className="text-xs text-gray-500 mb-2">{loc?.address || ''}, {loc?.city || ''}</div>
                <div className="flex flex-wrap gap-1 mb-1">
                  {scope.map((s: string) => (
                    <span key={s} className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-[#1a1e28] text-gray-400">{s}</span>
                  ))}
                  {isPast && <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-red-500/10 text-red-500">overdue</span>}
                </div>
                <div className="font-mono text-sm font-semibold text-emerald-500">${est.toLocaleString()}</div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
