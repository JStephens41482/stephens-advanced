'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { getRateCard, calcSuppressionPrice, calcTravelCharge, RateCard } from '@/lib/rates'
import { resolveCartridge } from '@/lib/parts-engine'
import BottomNav from '@/components/BottomNav'
import TodayView from '@/components/TodayView'
import ScheduleView from '@/components/ScheduleView'
import CustomersView from '@/components/CustomersView'
import MoneyView from '@/components/MoneyView'
import JobDetail from '@/components/JobDetail'
import NewJobSheet from '@/components/NewJobSheet'
import NewCustomerSheet from '@/components/NewCustomerSheet'

export default function Home() {
  const [activeView, setActiveView] = useState('today')
  const [rates, setRates] = useState<RateCard | null>(null)
  const [jobs, setJobs] = useState<any[]>([])
  const [customers, setCustomers] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [showJobDetail, setShowJobDetail] = useState(false)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [showNewJob, setShowNewJob] = useState(false)
  const [showNewCustomer, setShowNewCustomer] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [rateData, jobData, custData, invData] = await Promise.all([
        getRateCard(),
        loadJobs(),
        loadCustomers(),
        loadInvoices(),
      ])
      setRates(rateData)
      setJobs(jobData)
      setCustomers(custData)
      setInvoices(invData)
    } catch (err) {
      console.error('Failed to load data:', err)
    }
    setLoading(false)
  }

  async function loadJobs() {
    const { data, error } = await supabase
      .from('jobs')
      .select(`
        *,
        location:locations(
          *,
          billing_account:billing_accounts(*),
          extinguishers(*),
          suppression_systems(*),
          emergency_lights(*)
        )
      `)
      .order('scheduled_date', { ascending: true })
      .order('scheduled_time', { ascending: true })

    if (error) {
      console.error('Jobs load error:', error)
      return []
    }
    return data || []
  }

  async function loadCustomers() {
    const { data, error } = await supabase
      .from('locations')
      .select(`
        *,
        billing_account:billing_accounts(*),
        extinguishers(id),
        suppression_systems(id),
        emergency_lights(id)
      `)
      .order('name', { ascending: true })

    if (error) {
      console.error('Customers load error:', error)
      return []
    }
    return data || []
  }

  async function loadInvoices() {
    const { data, error } = await supabase
      .from('invoices')
      .select('*, invoice_lines(*)')
      .order('date', { ascending: false })
      .limit(50)

    if (error) {
      console.error('Invoices load error:', error)
      return []
    }
    return data || []
  }

  function openJobDetail(jobId: string) {
    setSelectedJobId(jobId)
    setShowJobDetail(true)
  }

  function closeJobDetail() {
    setShowJobDetail(false)
    setSelectedJobId(null)
    loadData() // refresh after closing
  }

  const today = new Date().toISOString().split('T')[0]
  const todayJobs = jobs.filter(j => j.scheduled_date === today)
  const upcomingJobs = jobs.filter(j => j.status !== 'completed' && j.status !== 'cancelled')
  const overdueJobs = jobs.filter(j => j.status === 'scheduled' && j.scheduled_date < today)

  const collected30d = invoices
    .filter(i => i.status === 'paid' && new Date(i.paid_at) > new Date(Date.now() - 30 * 86400000))
    .reduce((s, i) => s + Number(i.total), 0)

  const outstanding = invoices
    .filter(i => i.status !== 'paid' && i.status !== 'void')
    .reduce((s, i) => s + Number(i.total), 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0c10]">
        <div className="text-center">
          <div className="text-2xl font-bold mb-2">
            Stephens <span className="text-[#e85d26]">Advanced</span>
          </div>
          <div className="text-sm text-gray-500">Loading...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-[#0a0c10] overflow-hidden">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 flex-shrink-0">
        <div className="text-[17px] font-bold tracking-tight">
          Stephens <span className="text-[#e85d26]">Advanced</span>
        </div>
        <div className="text-xs text-gray-500 font-medium">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 pb-28">
        {activeView === 'today' && (
          <TodayView
            jobs={todayJobs}
            rates={rates}
            overdueCount={overdueJobs.length}
            onOpenJob={openJobDetail}
            onStartJob={(id) => setActiveJobId(id)}
            activeJobId={activeJobId}
          />
        )}
        {activeView === 'schedule' && (
          <ScheduleView
            jobs={upcomingJobs}
            rates={rates}
            onOpenJob={openJobDetail}
          />
        )}
        {activeView === 'customers' && (
          <CustomersView
            customers={customers}
            onOpenCustomer={(id) => {/* TODO */}}
          />
        )}
        {activeView === 'money' && (
          <MoneyView
            invoices={invoices}
            collected={collected30d}
            outstanding={outstanding}
          />
        )}
      </div>

      {/* FAB */}
      <button
        onClick={() => setShowNewJob(true)}
        className="fixed bottom-24 right-4 w-14 h-14 bg-[#e85d26] text-white rounded-full text-2xl flex items-center justify-center shadow-lg shadow-orange-900/40 active:scale-95 transition-transform z-40"
      >
        +
      </button>

      {/* Bottom Nav */}
      <BottomNav active={activeView} onChange={setActiveView} />

      {/* Job Detail Overlay */}
      {showJobDetail && selectedJobId && (
        <JobDetail
          jobId={selectedJobId}
          jobs={jobs}
          rates={rates}
          onClose={closeJobDetail}
          onComplete={async () => {
            await loadData()
            closeJobDetail()
          }}
        />
      )}

      {/* New Job Sheet */}
      {showNewJob && (
        <NewJobSheet
          customers={customers}
          onClose={() => setShowNewJob(false)}
          onCreated={() => {
            setShowNewJob(false)
            loadData()
          }}
        />
      )}

      {/* New Customer Sheet */}
      {showNewCustomer && (
        <NewCustomerSheet
          onClose={() => setShowNewCustomer(false)}
          onCreated={() => {
            setShowNewCustomer(false)
            loadData()
          }}
        />
      )}
    </div>
  )
}
