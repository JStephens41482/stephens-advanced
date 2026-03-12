'use client'

import { useState, useRef, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { RateCard, calcSuppressionPrice } from '@/lib/rates'

export default function JobDetail({
  jobId,
  jobs,
  rates,
  onClose,
  onComplete,
}: {
  jobId: string
  jobs: any[]
  rates: RateCard | null
  onClose: () => void
  onComplete: () => void
}) {
  const job = jobs.find(j => j.id === jobId)
  const [extResults, setExtResults] = useState<Record<string, string>>({})
  const [sigData, setSigData] = useState<string | null>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [showInvoice, setShowInvoice] = useState(false)
  const [invoiceData, setInvoiceData] = useState<any>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)

  if (!job || !job.location) return null

  const loc = job.location
  const scope = job.scope || []

  function setExtStatus(extId: string, status: string) {
    setExtResults(prev => ({ ...prev, [extId]: status }))
  }

  // Signature pad
  function initCanvas() {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.parentElement!.getBoundingClientRect()
    canvas.width = rect.width
    canvas.height = rect.height
    const ctx = canvas.getContext('2d')!
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctxRef.current = ctx
  }

  useEffect(() => {
    setTimeout(initCanvas, 100)
  }, [])

  function getPos(e: any) {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const touch = e.touches ? e.touches[0] : e
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top }
  }

  function startDraw(e: any) {
    e.preventDefault()
    setIsDrawing(true)
    const pos = getPos(e)
    ctxRef.current?.beginPath()
    ctxRef.current?.moveTo(pos.x, pos.y)
  }

  function draw(e: any) {
    if (!isDrawing) return
    e.preventDefault()
    const pos = getPos(e)
    ctxRef.current?.lineTo(pos.x, pos.y)
    ctxRef.current?.stroke()
  }

  function endDraw() {
    setIsDrawing(false)
    if (canvasRef.current) {
      setSigData(canvasRef.current.toDataURL())
    }
  }

  function clearSig() {
    const canvas = canvasRef.current
    if (canvas && ctxRef.current) {
      ctxRef.current.clearRect(0, 0, canvas.width, canvas.height)
    }
    setSigData(null)
  }

  async function completeJob() {
    if (completing) return
    setCompleting(true)

    try {
      if (!rates) return

      // Build invoice lines
      const lines: Array<{ description: string; quantity: number; unit_price: number; total: number }> = []
      let subtotal = 0

      // Suppression systems
      if (scope.includes('suppression')) {
        for (const sys of (loc.suppression_systems || [])) {
          const price = calcSuppressionPrice(sys.category, sys.tank_count, rates)
          lines.push({
            description: `${sys.system_type} Semi-Annual Inspection (${sys.tank_count} tank${sys.tank_count > 1 ? 's' : ''})`,
            quantity: 1,
            unit_price: price,
            total: price,
          })
          subtotal += price

          if (sys.fusible_link_count > 0) {
            const linkTotal = sys.fusible_link_count * rates.fusible_link
            lines.push({
              description: `Fusible Links`,
              quantity: sys.fusible_link_count,
              unit_price: rates.fusible_link,
              total: linkTotal,
            })
            subtotal += linkTotal
          }

          if (sys.nozzle_count > 0) {
            const capTotal = sys.nozzle_count * rates.metal_blowoff_cap
            lines.push({
              description: `Blow-Off Caps`,
              quantity: sys.nozzle_count,
              unit_price: rates.metal_blowoff_cap,
              total: capTotal,
            })
            subtotal += capTotal
          }
        }
      }

      // Extinguishers
      if (scope.includes('extinguishers') && loc.extinguishers?.length > 0) {
        const extCount = loc.extinguishers.length
        const extTotal = extCount * rates.extinguisher_inspection
        lines.push({
          description: `Portable Extinguisher Inspection`,
          quantity: extCount,
          unit_price: rates.extinguisher_inspection,
          total: extTotal,
        })
        subtotal += extTotal

        // Add replacements
        for (const [extId, status] of Object.entries(extResults)) {
          if (status === 'replace') {
            const ext = loc.extinguishers.find((e: any) => e.id === extId)
            const price = ext?.size === '5lb' ? rates.new_5lb_ext : rates.new_10lb_ext
            lines.push({
              description: `New ${ext?.size || ''} ${ext?.type || ''} Extinguisher (replacement)`,
              quantity: 1,
              unit_price: price,
              total: price,
            })
            subtotal += price
          }
        }
      }

      // Emergency lights
      if (scope.includes('elights')) {
        const el = loc.emergency_lights?.[0]
        if (el && el.fixture_count > 0) {
          const elTotal = el.fixture_count * rates.emergency_light
          lines.push({
            description: `Emergency Light Annual Test (90-min)`,
            quantity: el.fixture_count,
            unit_price: rates.emergency_light,
            total: elTotal,
          })
          subtotal += elTotal
        }
      }

      // Travel charge
      const travelCharge = Number(job.travel_charge) || 0

      const total = subtotal + travelCharge

      // Create invoice
      const { data: invoice, error: invError } = await supabase
        .from('invoices')
        .insert({
          job_id: job.id,
          location_id: loc.id,
          billing_account_id: loc.billing_account_id,
          subtotal,
          travel_charge: travelCharge,
          total,
          status: 'sent',
          sent_at: new Date().toISOString(),
        })
        .select()
        .single()

      if (invError) throw invError

      // Insert line items
      if (invoice) {
        const lineInserts = lines.map((line, i) => ({
          invoice_id: invoice.id,
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unit_price,
          total: line.total,
          sort_order: i,
        }))

        await supabase.from('invoice_lines').insert(lineInserts)

        // Travel charge as line item
        if (travelCharge > 0) {
          await supabase.from('invoice_lines').insert({
            invoice_id: invoice.id,
            description: 'Travel Charge',
            quantity: 1,
            unit_price: travelCharge,
            total: travelCharge,
            sort_order: lines.length,
          })
        }
      }

      // Update job status
      await supabase
        .from('jobs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          signature_data: sigData,
        })
        .eq('id', job.id)

      // Save extinguisher results
      for (const [extId, status] of Object.entries(extResults)) {
        await supabase.from('extinguisher_results').insert({
          job_id: job.id,
          extinguisher_id: extId,
          status,
        })
      }

      setInvoiceData({ ...invoice, lines, total, subtotal, travel_charge: travelCharge })
      setShowInvoice(true)

    } catch (err) {
      console.error('Complete job error:', err)
      alert('Error completing job. Check console.')
    }

    setCompleting(false)
  }

  if (showInvoice && invoiceData) {
    return (
      <div className="fixed inset-0 z-[300] bg-black/90 overflow-y-auto p-4">
        <div className="bg-white text-gray-900 rounded-xl p-6 max-w-md mx-auto">
          <h2 className="text-xl font-extrabold mb-0.5">Invoice</h2>
          <div className="text-xs text-gray-400 mb-1">{invoiceData.invoice_number}</div>
          <div className="text-xs text-gray-500 mb-4">
            {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </div>

          <div className="text-sm pb-3 border-b border-gray-100 mb-3">
            <strong className="block text-[15px]">{loc.name}</strong>
            {loc.address}, {loc.city}
          </div>

          {invoiceData.lines.map((line: any, i: number) => (
            <div key={i} className="flex justify-between py-1.5 text-sm border-b border-gray-50">
              <div className="flex-1 pr-3">
                {line.description}
                {line.quantity > 1 && <span className="text-gray-400 ml-1">×{line.quantity}</span>}
              </div>
              <div className="font-mono font-semibold">${line.total.toFixed(2)}</div>
            </div>
          ))}

          {invoiceData.travel_charge > 0 && (
            <div className="flex justify-between py-1.5 text-sm border-b border-gray-50">
              <div>Travel Charge</div>
              <div className="font-mono font-semibold">${invoiceData.travel_charge.toFixed(2)}</div>
            </div>
          )}

          <div className="flex justify-between mt-3 pt-3 border-t-2 border-gray-900 text-lg font-extrabold">
            <div>Total Due</div>
            <div className="font-mono">${invoiceData.total.toFixed(2)}</div>
          </div>

          <div className="flex gap-2 mt-5">
            <button
              onClick={() => { onComplete() }}
              className="flex-1 py-3.5 rounded-xl bg-gray-100 text-gray-700 font-bold text-sm"
            >
              Done
            </button>
            <button
              onClick={() => { onComplete() }}
              className="flex-1 py-3.5 rounded-xl bg-[#e85d26] text-white font-bold text-sm"
            >
              Send to Customer
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[200] bg-[#0a0c10] overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-[#0a0c10] px-4 py-3 flex items-center gap-3 border-b border-[#2a3040]">
        <button onClick={onClose} className="text-2xl text-gray-300 p-1">←</button>
        <div className="text-[17px] font-bold">{loc.name}</div>
      </div>

      <div className="px-4 pt-4 pb-32">
        {/* Location info */}
        <div className="mb-5">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Location</div>
          <div className="text-sm text-gray-400">{loc.address}, {loc.city}, {loc.state} {loc.zip}</div>
          {loc.contact_name && (
            <div className="text-xs text-gray-500 mt-1">
              Contact: {loc.contact_name} — {loc.contact_phone}
            </div>
          )}
        </div>

        {/* Suppression Systems */}
        {scope.includes('suppression') && (loc.suppression_systems || []).length > 0 && (
          <div className="mb-5">
            <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Suppression Systems</div>
            {loc.suppression_systems.map((sys: any) => {
              const price = rates ? calcSuppressionPrice(sys.category, sys.tank_count, rates) : 0
              return (
                <div key={sys.id} className="bg-[#12151c] border border-[#2a3040] rounded-lg p-3 mb-1.5">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="text-sm font-semibold">{sys.system_type}</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">
                        {sys.tank_count} tank{sys.tank_count > 1 ? 's' : ''} · {sys.nozzle_count} nozzles · {sys.fusible_link_count} links
                      </div>
                    </div>
                    <div className="font-mono text-sm font-semibold text-emerald-500">${price}</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Extinguishers */}
        {scope.includes('extinguishers') && (loc.extinguishers || []).length > 0 && (
          <div className="mb-5">
            <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">
              Extinguishers ({loc.extinguishers.length})
            </div>
            {loc.extinguishers.map((ext: any) => {
              const selected = extResults[ext.id]
              return (
                <div key={ext.id} className="bg-[#12151c] border border-[#2a3040] rounded-lg p-3 mb-1.5">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <div className="text-sm font-semibold">{ext.type} {ext.size}</div>
                      <div className="text-[11px] text-gray-500">{ext.location_in_building} · {ext.serial_number}</div>
                    </div>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {['pass', 'swap', 'replace', 'condemn', 'remove'].map(status => (
                      <button
                        key={status}
                        onClick={() => setExtStatus(ext.id, status)}
                        className={`px-2.5 py-1.5 rounded text-[10px] font-bold uppercase border transition-colors ${
                          selected === status
                            ? status === 'pass' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500'
                            : status === 'swap' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500'
                            : status === 'replace' ? 'bg-[#e85d26]/10 text-[#e85d26] border-[#e85d26]'
                            : status === 'condemn' ? 'bg-red-500/10 text-red-500 border-red-500'
                            : 'bg-gray-500/10 text-gray-400 border-gray-500'
                            : 'bg-[#1a1e28] text-gray-500 border-[#2a3040]'
                        }`}
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Emergency Lights */}
        {scope.includes('elights') && loc.emergency_lights?.[0]?.fixture_count > 0 && (
          <div className="mb-5">
            <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">
              Emergency Lighting ({loc.emergency_lights[0].fixture_count} fixtures)
            </div>
            <div className="bg-[#12151c] border border-[#2a3040] rounded-lg p-3">
              <div className="flex justify-between items-center">
                <div>
                  <div className="text-sm font-semibold">90-Minute Annual Test</div>
                  <div className="text-[11px] text-gray-500">
                    {loc.emergency_lights[0].fixture_count} fixtures × ${rates?.emergency_light || 20}
                  </div>
                </div>
                <div className="font-mono text-sm font-semibold text-emerald-500">
                  ${(loc.emergency_lights[0].fixture_count * (rates?.emergency_light || 20))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Signature */}
        <div className="mb-5">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Customer Signature</div>
          <div className="bg-white rounded-xl h-36 relative" style={{ touchAction: 'none' }}>
            <canvas
              ref={canvasRef}
              className="w-full h-full rounded-xl"
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={endDraw}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={endDraw}
            />
            {!sigData && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">
                Sign here
              </div>
            )}
            <button
              onClick={clearSig}
              className="absolute top-2 right-2 bg-black/50 text-white text-[11px] px-2 py-1 rounded"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Complete button */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-[#12151c] border-t border-[#2a3040] z-[210]">
        <button
          onClick={completeJob}
          disabled={completing}
          className="w-full py-4 bg-[#e85d26] text-white rounded-xl text-base font-extrabold active:opacity-80 disabled:opacity-50"
        >
          {completing ? 'Generating Invoice...' : 'Complete Job — Generate Invoice'}
        </button>
      </div>
    </div>
  )
}
