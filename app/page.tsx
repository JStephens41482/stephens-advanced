'use client'

import { useState, useRef, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

// ─── System prompt that makes Claude think like Jon's assistant ───
const SYSTEM_PROMPT = `You are the AI assistant for Stephens Advanced, a fire suppression contracting business in DFW, Texas, owned by Jon Stephens. You run inside an app on Jon's phone. Your job is to compress his work so he can go home to his son William.

You have direct access to the business database. When Jon tells you to do something, you do it — create customers, schedule jobs, generate invoices, check what's overdue, calculate what he needs on the truck. You don't ask unnecessary questions. You figure it out from context.

CRITICAL RULES:
- Be concise. Jon is in his truck. Short, clear responses.
- When creating jobs/customers, confirm with a brief summary before saving.
- When Jon says "yes", "yeah", "do it", "confirmed" — execute the pending action.
- Always think about routing — cluster nearby jobs together.
- Know that Fort Worth is a Brycer jurisdiction. Flag it when relevant.
- Jon's base is in Euless, TX. Calculate travel from there.
- Free travel radius: 50 miles. Beyond that: $250/hr + IRS mileage rate round trip.

RATE CARD:
- Extinguisher inspection: $20/ea
- Suppression semi-annual: Standard $250, Captive-Aire Tank $450, Captive-Aire CORE $650, +$50/additional tank (all types)
- Emergency lighting: $20/fixture (90-min annual test)
- Hydro: Class K $275, CO2 $72, H2O $57, ABC $68
- Dry chem internal: $68
- Labor: $200/hr
- Fusible links: $25/ea, Nozzles: $92.50, Silicone caps: $9, Metal blow-off caps: $25
- New 5lb ext: $102.50, New 10lb ext: $141.50
- Emergency calls: $500 / After hours $750 / Holiday-weekend $1,000

SMART PARTS BY SYSTEM TYPE:
- Ansul R-102: LT-10 or LT-30 nitrogen cartridge (LT-30 for multi-tank), rubber blow-off caps, Ansulex agent
- Pyro-Chem Kitchen Knight II: 16g CO2 cartridge, rubber caps
- Buckeye Kitchen Mister: nitrogen cartridge (small/large), stainless steel caps
- Kidde WHDR: XV nitrogen cartridge, foil seal caps
- Captive-Aire: uses one of the above component sets

NFPA 10 INTERVALS:
- Annual inspection: every extinguisher, every year
- 6-year internal: ABC/BC dry chemical only
- Hydro test: ABC/BC/Class D = 12 years, Class K/CO2/H2O = 5 years
- Suppression tanks: 12-year hydro
- Emergency lights: annual 90-minute test (NFPA 101 §7.9.3)

EXTINGUISHER STATUS OPTIONS: Pass, Swap, Replace, Condemn, Remove Unnecessary

When you receive database context, use it to answer questions about schedule, customers, overdue jobs, revenue, etc. Format currency as dollars. Format dates naturally (tomorrow, Thursday, March 20th).

When Jon asks what he needs on the truck, calculate from the equipment profiles of scheduled jobs.

You are not a chatbot. You are his business operations manager. Act like it.`

export default function Home() {
  const [messages, setMessages] = useState<Array<{role: string, content: string}>>([])
  const [input, setInput] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [pendingAction, setPendingAction] = useState<any>(null)
  const [dbContext, setDbContext] = useState<string>('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<any>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Load database context on mount
  useEffect(() => {
    loadDbContext()
    // Add welcome message
    const hour = new Date().getHours()
    const greeting = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'
    generateWelcome(greeting)
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function loadDbContext() {
    try {
      const today = new Date().toISOString().split('T')[0]

      // Get today's jobs
      const { data: todayJobs } = await supabase
        .from('jobs')
        .select('*, location:locations(*)')
        .eq('scheduled_date', today)
        .order('scheduled_time')

      // Get all overdue jobs
      const { data: overdueJobs } = await supabase
        .from('jobs')
        .select('*, location:locations(*)')
        .eq('status', 'scheduled')
        .lt('scheduled_date', today)

      // Get upcoming jobs (next 7 days)
      const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
      const { data: upcomingJobs } = await supabase
        .from('jobs')
        .select('*, location:locations(*)')
        .eq('status', 'scheduled')
        .gte('scheduled_date', today)
        .lte('scheduled_date', nextWeek)
        .order('scheduled_date')
        .order('scheduled_time')

      // Get all locations with equipment
      const { data: locations } = await supabase
        .from('locations')
        .select('*, extinguishers(id, type, size), suppression_systems(id, system_type, category, tank_count, nozzle_count, fusible_link_count), emergency_lights(id, fixture_count)')
        .order('name')

      // Get recent invoices
      const { data: invoices } = await supabase
        .from('invoices')
        .select('*')
        .order('date', { ascending: false })
        .limit(20)

      // Get billing accounts
      const { data: billingAccounts } = await supabase
        .from('billing_accounts')
        .select('*')

      const context = `
DATABASE STATE AS OF ${new Date().toLocaleString()}:

TODAY'S JOBS (${today}):
${todayJobs?.length ? todayJobs.map(j => `- ${j.location?.name || 'Unknown'} | ${j.location?.city || ''} | ${j.scheduled_time || 'no time'} | Scope: ${(j.scope || []).join(', ')} | Notes: ${j.notes || 'none'}`).join('\n') : 'No jobs scheduled today.'}

OVERDUE JOBS (${overdueJobs?.length || 0}):
${overdueJobs?.length ? overdueJobs.map(j => `- ${j.location?.name || 'Unknown'} | ${j.location?.city || ''} | Was due: ${j.scheduled_date} | Scope: ${(j.scope || []).join(', ')} | Notes: ${j.notes || 'none'}`).join('\n') : 'None overdue.'}

UPCOMING JOBS (next 7 days):
${upcomingJobs?.length ? upcomingJobs.map(j => `- ${j.scheduled_date} ${j.scheduled_time || ''} | ${j.location?.name || 'Unknown'} | ${j.location?.city || ''} | Scope: ${(j.scope || []).join(', ')}`).join('\n') : 'Nothing scheduled.'}

ALL CUSTOMERS (${locations?.length || 0} locations):
${locations?.map(l => `- ${l.name} | ${l.address || 'no address'}, ${l.city || 'no city'} | ${l.extinguishers?.length || 0} ext, ${l.suppression_systems?.length || 0} systems, ${l.emergency_lights?.[0]?.fixture_count || 0} e-lights${l.is_brycer_jurisdiction ? ' | BRYCER' : ''}`).join('\n') || 'No customers.'}

EQUIPMENT DETAILS:
${locations?.filter(l => l.suppression_systems?.length > 0).map(l => 
  l.suppression_systems.map((s: any) => `- ${l.name}: ${s.system_type} | ${s.category} | ${s.tank_count} tanks | ${s.nozzle_count} nozzles | ${s.fusible_link_count} links`).join('\n')
).join('\n') || 'No equipment data.'}

BILLING ACCOUNTS:
${billingAccounts?.map(b => `- ${b.name} | Contact: ${b.contact_name || 'none'} | Phone: ${b.phone || 'none'}`).join('\n') || 'None.'}

RECENT INVOICES:
${invoices?.map(i => `- ${i.invoice_number || 'no number'} | $${i.total} | ${i.status} | ${i.date}`).join('\n') || 'None.'}

REVENUE:
- Collected (paid invoices): $${invoices?.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0).toFixed(2) || '0'}
- Outstanding (unpaid): $${invoices?.filter(i => i.status !== 'paid' && i.status !== 'void').reduce((s, i) => s + Number(i.total), 0).toFixed(2) || '0'}
`
      setDbContext(context)
    } catch (err) {
      console.error('Failed to load DB context:', err)
      setDbContext('Database context unavailable.')
    }
  }

  async function generateWelcome(greeting: string) {
    setIsThinking(true)
    try {
      // Wait for db context
      await new Promise(r => setTimeout(r, 1500))
      
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: `${dbContext || 'Database loading...'}\n\nJon just opened the app. It's ${greeting.toLowerCase()} time. Give him a brief status — what's on today, anything overdue that needs attention, and what's coming up. Be concise, warm, and direct. If there are jobs today, mention what he needs on the truck. If no jobs today, tell him what's overdue and suggest what to tackle.`
          }]
        })
      })

      const data = await response.json()
      const text = data.content?.[0]?.text || `${greeting}, Jon. App is live. What do you need?`
      
      setMessages([{ role: 'assistant', content: text }])
    } catch (err) {
      console.error('Welcome error:', err)
      setMessages([{ role: 'assistant', content: `${greeting}, Jon. I'm here. What do you need?` }])
    }
    setIsThinking(false)
  }

  async function sendMessage(text: string) {
    if (!text.trim() || isThinking) return

    const userMsg = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setIsThinking(true)

    // Refresh db context before each message
    await loadDbContext()

    try {
      // Build conversation history for API
      const apiMessages = newMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.role === 'user' && m === userMsg
          ? `${dbContext}\n\nJon says: "${m.content}"\n\nIf Jon is asking you to create something (customer, job, etc.), describe what you'll create and ask for confirmation. If Jon is confirming a previous action (yes, yeah, do it, confirmed), execute it by describing exactly what was saved. Always be specific about what you did.`
          : m.content
      }))

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: apiMessages
        })
      })

      const data = await response.json()
      let assistantText = data.content?.[0]?.text || "Sorry, I didn't catch that. Try again."

      // Check if the response indicates we should execute a database action
      await executeActions(text, assistantText)

      setMessages(prev => [...prev, { role: 'assistant', content: assistantText }])
    } catch (err) {
      console.error('Message error:', err)
      setMessages(prev => [...prev, { role: 'assistant', content: "Connection issue. Try again." }])
    }

    setIsThinking(false)
  }

  async function executeActions(userText: string, assistantResponse: string) {
    const lower = userText.toLowerCase().trim()

    // If user confirms a pending action
    if (pendingAction && (lower === 'yes' || lower === 'yeah' || lower === 'do it' || lower === 'confirmed' || lower === 'yep' || lower === 'go')) {
      try {
        if (pendingAction.type === 'create_job') {
          // Create billing account if needed
          let billingAccountId = null
          if (pendingAction.billingName) {
            const { data: existingBa } = await supabase
              .from('billing_accounts')
              .select('id')
              .ilike('name', `%${pendingAction.billingName}%`)
              .limit(1)

            if (existingBa?.length) {
              billingAccountId = existingBa[0].id
            } else {
              const { data: newBa } = await supabase
                .from('billing_accounts')
                .insert({ name: pendingAction.billingName, contact_name: pendingAction.billingContact || null, phone: pendingAction.billingPhone || null })
                .select().single()
              billingAccountId = newBa?.id
            }
          }

          // Create or find location
          let locationId = pendingAction.locationId
          if (!locationId) {
            const { data: existingLoc } = await supabase
              .from('locations')
              .select('id')
              .ilike('name', `%${pendingAction.customerName}%`)
              .limit(1)

            if (existingLoc?.length) {
              locationId = existingLoc[0].id
            } else {
              const { data: newLoc } = await supabase
                .from('locations')
                .insert({
                  name: pendingAction.customerName,
                  address: pendingAction.address || null,
                  city: pendingAction.city || null,
                  state: pendingAction.state || 'TX',
                  zip: pendingAction.zip || null,
                  contact_phone: pendingAction.phone || null,
                  billing_account_id: billingAccountId,
                  is_brycer_jurisdiction: (pendingAction.city || '').toLowerCase() === 'fort worth',
                  brycer_ahj_name: (pendingAction.city || '').toLowerCase() === 'fort worth' ? 'Fort Worth Fire Department' : null,
                })
                .select().single()
              locationId = newLoc?.id
            }
          }

          // Create job
          if (locationId) {
            await supabase.from('jobs').insert({
              location_id: locationId,
              billing_account_id: billingAccountId,
              type: pendingAction.jobType || 'inspection',
              scope: pendingAction.scope || ['extinguishers', 'suppression'],
              scheduled_date: pendingAction.date || new Date(Date.now() + 86400000).toISOString().split('T')[0],
              scheduled_time: pendingAction.time || '09:00',
              status: 'scheduled',
              notes: pendingAction.notes || null,
            })
          }
        }

        if (pendingAction.type === 'reschedule') {
          if (pendingAction.jobId && pendingAction.newDate) {
            await supabase.from('jobs')
              .update({ scheduled_date: pendingAction.newDate, scheduled_time: pendingAction.newTime || null })
              .eq('id', pendingAction.jobId)
          }
        }

        if (pendingAction.type === 'cancel_job') {
          if (pendingAction.jobId) {
            await supabase.from('jobs')
              .update({ status: 'cancelled', notes: pendingAction.reason || 'Cancelled' })
              .eq('id', pendingAction.jobId)
          }
        }

        setPendingAction(null)
        await loadDbContext()
        return
      } catch (err) {
        console.error('Action execution error:', err)
      }
    }

    // Parse new actions from the conversation
    // Detect job creation intent
    if (assistantResponse.toLowerCase().includes('confirm') || assistantResponse.toLowerCase().includes('sound right') || assistantResponse.toLowerCase().includes('want me to')) {
      // Try to extract action details from the conversation
      const action = parseActionFromConversation(userText, assistantResponse)
      if (action) {
        setPendingAction(action)
      }
    }
  }

  function parseActionFromConversation(userText: string, response: string): any {
    const lower = userText.toLowerCase()

    // Detect new job/customer creation
    if (lower.includes('new job') || lower.includes('new customer') || lower.includes('schedule') || lower.includes('add')) {
      const action: any = { type: 'create_job' }

      // Try to extract customer name (first capitalized words or quoted text)
      const nameMatch = userText.match(/(?:at|for|called)\s+([A-Z][^,.\d]*?)(?:\s+(?:in|on|at|tomorrow|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday))/i)
        || userText.match(/(?:new job|new customer|schedule)\s+([A-Z][^,.\d]*?)(?:\s+(?:in|on|at|tomorrow))/i)
      if (nameMatch) action.customerName = nameMatch[1].trim()

      // Try to extract city
      const cityMatch = userText.match(/(?:in|,)\s+(Fort Worth|Dallas|Arlington|Irving|Bedford|McKinney|Sachse|Melissa|Glen Rose|Euless|Weatherford|Denton)/i)
      if (cityMatch) action.city = cityMatch[1]

      // Try to extract date
      if (lower.includes('tomorrow')) {
        action.date = new Date(Date.now() + 86400000).toISOString().split('T')[0]
      } else if (lower.includes('today')) {
        action.date = new Date().toISOString().split('T')[0]
      }

      // Try to extract scope
      action.scope = []
      if (lower.includes('suppression') || lower.includes('hood') || lower.includes('system')) action.scope.push('suppression')
      if (lower.includes('extinguisher') || lower.includes('ext')) action.scope.push('extinguishers')
      if (lower.includes('light') || lower.includes('e-light') || lower.includes('emergency light')) action.scope.push('elights')
      if (action.scope.length === 0) action.scope = ['extinguishers', 'suppression']

      // Try to extract billing
      const billMatch = userText.match(/bill(?:ed|ing)?\s+(?:to|through)\s+([^,.]+)/i)
      if (billMatch) action.billingName = billMatch[1].trim()

      // Try to extract address
      const addrMatch = userText.match(/(\d+[^,]*(?:st|rd|ave|blvd|dr|ln|way|hwy|tx-?\d+)[^,]*)/i)
      if (addrMatch) action.address = addrMatch[1].trim()

      if (action.customerName) return action
    }

    return null
  }

  // Voice recognition
  function startListening() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert('Voice not supported in this browser. Use Chrome.')
      return
    }

    const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onstart = () => setIsListening(true)

    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      setInput(transcript)
    }

    recognition.onend = () => {
      setIsListening(false)
      // Auto-send if we got text
      if (input.trim()) {
        sendMessage(input.trim())
      }
    }

    recognition.onerror = (event: any) => {
      console.error('Speech error:', event.error)
      setIsListening(false)
    }

    recognitionRef.current = recognition
    recognition.start()
  }

  function stopListening() {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-[#0a0c10]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-[#2a3040] flex-shrink-0">
        <div className="text-[17px] font-bold tracking-tight">
          Stephens <span className="text-[#e85d26]">Advanced</span>
        </div>
        <div className="text-xs text-gray-500 font-medium">
          {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-4">
        {messages.map((msg, i) => (
          <div key={i} className={`mb-4 ${msg.role === 'user' ? 'flex justify-end' : ''}`}>
            {msg.role === 'assistant' ? (
              <div className="max-w-[90%]">
                <div className="text-[13px] leading-relaxed text-gray-200 whitespace-pre-wrap">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="max-w-[85%] bg-[#e85d26] rounded-2xl rounded-br-sm px-4 py-2.5">
                <div className="text-[14px] text-white">
                  {msg.content}
                </div>
              </div>
            )}
          </div>
        ))}

        {isThinking && (
          <div className="mb-4">
            <div className="flex gap-1.5 px-1">
              <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{animationDelay: '0ms'}} />
              <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{animationDelay: '150ms'}} />
              <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{animationDelay: '300ms'}} />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-[#2a3040] bg-[#12151c] px-3 py-3 pb-8">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isListening ? "Listening..." : "Talk or type..."}
              rows={1}
              className="w-full px-4 py-3 bg-[#1a1e28] border border-[#2a3040] rounded-2xl text-[15px] text-gray-200 outline-none focus:border-[#e85d26] resize-none max-h-32 placeholder-gray-600"
              style={{ minHeight: '46px' }}
            />
          </div>

          {/* Mic button */}
          <button
            onClick={isListening ? stopListening : startListening}
            className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
              isListening
                ? 'bg-red-500 animate-pulse shadow-lg shadow-red-500/30'
                : 'bg-[#1a1e28] border border-[#2a3040]'
            }`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={isListening ? '#fff' : '#6b7280'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          </button>

          {/* Send button */}
          {input.trim() && (
            <button
              onClick={() => sendMessage(input)}
              className="w-12 h-12 rounded-full bg-[#e85d26] flex items-center justify-center flex-shrink-0"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
