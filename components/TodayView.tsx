'use client'

import { RateCard, calcSuppressionPrice } from '@/lib/rates'
import { resolveCartridge } from '@/lib/parts-engine'
import { useState } from 'react'

function estimateJobValue(job: any, rates: RateCard | null): number {
  if (!rates || !job.location) return 0
  const loc = job.location
  let total = 0
  const scope = job.scope || []

  if (scope.includes('extinguishers')) {
    total += (loc.extinguishers?.length || 0) * rates.extinguisher_inspection
  }

  if (scope.includes('suppression')) {
    for (const sys of (loc.suppression_systems || [])) {
      total += calcSuppressionPrice(sys.category, sys.tank_count, rates)
      total += (sys.fusible_link_count || 0) * rates.fusible_link
      total += (sys.nozzle_count || 0) * rates.metal_blowoff_cap
    }
  }

  if (scope.includes('elights')) {
    const elights = loc.emergency_lights?.[0]
    if (elights) total += (elights.fixture_count || 0) * rates.emergency_light
  }

  return total
}

function calcLoadList(jobs: any[]) {
  let tags = 0, links = 0, caps = 0
  const cartridges: string[] = []

  for (const job of jobs) {
    const loc = job.location
    if (!loc) continue
    const scope = job.scope || []

    if (scope.includes('extinguishers')) {
      tags += loc.extinguishers?.length || 0
    }

    if (scope.includes('suppression')) {
      for (const sys of (loc.suppression_systems || [])) {
        links += sys.fusible_link_count || 0
        caps += sys.nozzle_count || 0
        cartridges.push(resolveCartridge(sys.system_type, sys.tank_count))
      }
    }
  }

  return { tags, links, caps, cartridges }
}

function formatMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function TodayView({
  jobs,
  rates,
  overdueCount,
  onOpenJob,
  onStartJob,
  activeJobId,
}: {
  jobs: any[]
  rates: RateCard | null
  overdueCount: number
  onOpenJob: (id: string) => void
  onStartJob: (id: string) => void
  activeJobId: string | null
}) {
  const [readyConfirmed, setReadyConfirmed] = useState(false)

  const estimated = jobs.reduce((sum, j) => sum + estimateJobValue(j, rates), 0)
  const load = calcLoadList(jobs)

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-1">
        <div className="bg-[#12151c] border border-[#2a3040] rounded-xl p-3 text-center">
          <div className="font-mono text-xl font-bold text-[#e85d26]">{jobs.length}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mt-1">Jobs Today</div>
        </div>
        <div className="bg-[#12151c] border border-[#2a3040] rounded-xl p-3 text-center">
          <div className="font-mono text-xl font-bold text-emerald-500">{formatMoney(estimated)}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mt-1">Estimated</div>
        </div>
        <div className="bg-[#12151c] border border-[#2a3040] rounded-xl p-3 text-center">
          <div className="font-mono text-xl font-bold text-yellow-500">{overdueCount}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mt-1">Overdue</div>
        </div>
      </div>

      {/* Readiness Check */}
      <div className="mt-5 mb-1">
        <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Truck Readiness</div>
      </div>
      <div className="bg-[#12151c] border border-[#2a3040] rounded-xl p-3 mb-1">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-bold">Today's Load</div>
          <div className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full ${
            readyConfirmed
              ? 'bg-emerald-500/10 text-emerald-500'
              : 'bg-yellow-500/10 text-yellow-500'
          }`}>
            {readyConfirmed ? 'Ready' : 'Check'}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {jobs.length === 0 ? (
            <div className="text-xs text-gray-500">No jobs scheduled</div>
          ) : (
            <>
              {load.tags > 0 && (
                <div className="flex items-center gap-1.5 bg-[#1a1e28] rounded-md px-2.5 py-1.5 text-xs font-medium">
                  <span className="font-mono font-semibold text-[#e85d26]">{load.tags}</span> Tags
                </div>
              )}
              {load.links > 0 && (
                <div className="flex items-center gap-1.5 bg-[#1a1e28] rounded-md px-2.5 py-1.5 text-xs font-medium">
                  <span className="font-mono font-semibold text-[#e85d26]">{load.links}</span> Links
                </div>
              )}
              {load.caps > 0 && (
                <div className="flex items-center gap-1.5 bg-[#1a1e28] rounded-md px-2.5 py-1.5 text-xs font-medium">
                  <span className="font-mono font-semibold text-[#e85d26]">{load.caps}</span> Caps
                </div>
              )}
              {load.cartridges.map((c, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-[#1a1e28] rounded-md px-2.5 py-1.5 text-xs font-medium">
                  <span className="font-mono font-semibold text-[#e85d26]">1</span> {c}
                </div>
              ))}
            </>
          )}
        </div>
        <button
          onClick={() => setReadyConfirmed(true)}
          className={`w-full py-2.5 rounded-lg text-sm font-bold transition-colors ${
            readyConfirmed
              ? 'bg-emerald-500 text-white'
              : 'bg-[#e85d26] text-white active:opacity-80'
          }`}
        >
          {readyConfirmed ? '✓ Confirmed' : 'I have everything'}
        </button>
      </div>

      {/* Today's Jobs */}
      <div className="mt-5 mb-2 flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-wider text-gray-500">Today's Jobs</div>
      </div>

      {jobs.length === 0 ? (
        <div className="text-center py-10 text-gray-500">
          <div className="text-4xl mb-3 opacity-30">📋</div>
          <div className="text-sm">No jobs scheduled for today.<br/>Tap + to create one.</div>
        </div>
      ) : (
        jobs.map(job => {
          const loc = job.location
          const est = estimateJobValue(job, rates)
          const isActive = activeJobId === job.id
          const scope = job.scope || []

          return (
            <div
              key={job.id}
              onClick={() => onOpenJob(job.id)}
              className={`bg-[#12151c] border border-[#2a3040] rounded-xl p-3.5 mb-2 relative overflow-hidden active:border-[#e85d26] transition-colors cursor-pointer`}
            >
              {/* Status bar */}
              <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${
                job.status === 'active' ? 'bg-emerald-500' :
                job.status === 'completed' ? 'bg-gray-600' :
                'bg-blue-500'
              }`} />

              <div className="flex justify-between items-start mb-1.5">
                <div className="text-[15px] font-bold leading-tight">{loc?.name || 'Unknown'}</div>
                <div className="font-mono text-xs text-gray-500 ml-2 whitespace-nowrap">{job.scheduled_time?.slice(0, 5) || ''}</div>
              </div>

              <div className="text-xs text-gray-500 mb-2">{loc?.address || ''}, {loc?.city || ''}</div>

              <div className="flex flex-wrap gap-1 mb-2">
                {scope.includes('suppression') && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-[#e85d26]/10 text-[#e85d26]">suppression</span>
                )}
                {scope.includes('extinguishers') && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-500">extinguishers</span>
                )}
                {scope.includes('elights') && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-500">e-lights</span>
                )}
                {scope.includes('hydro') && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-blue-500/10 text-blue-500">hydro</span>
                )}
              </div>

              <div className="font-mono text-sm font-semibold text-emerald-500">{formatMoney(est)}</div>

              <div className="flex gap-1.5 mt-2.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (loc?.address) {
                      window.open(`https://maps.apple.com/?daddr=${encodeURIComponent(loc.address + ', ' + loc.city + ', ' + loc.state + ' ' + loc.zip)}`, '_blank')
                    }
                  }}
                  className="flex-1 py-2.5 rounded-lg text-xs font-bold bg-[#222735] text-gray-300 border border-[#2a3040] active:opacity-80"
                >
                  Navigate
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onStartJob(job.id)
                  }}
                  className={`flex-1 py-2.5 rounded-lg text-xs font-bold active:opacity-80 ${
                    isActive
                      ? 'bg-emerald-500 text-white'
                      : 'bg-[#e85d26] text-white'
                  }`}
                >
                  {isActive ? 'In Progress' : 'Start Job'}
                </button>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
