-- ============================================
-- STEPHENS ADVANCED — DATABASE SCHEMA
-- Run this in Supabase SQL Editor
-- ============================================

-- ─── BILLING ACCOUNTS ───
-- The entity that pays. Could be a franchise group, 
-- management company, or same as the location.
CREATE TABLE billing_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT DEFAULT 'TX',
  zip TEXT,
  w9_on_file BOOLEAN DEFAULT FALSE,
  coi_on_file BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── LOCATIONS ───
-- Physical sites where work happens.
-- A billing account can have many locations.
CREATE TABLE locations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  billing_account_id UUID REFERENCES billing_accounts(id),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT DEFAULT 'TX',
  zip TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  distance_from_base DOUBLE PRECISION, -- miles, auto-calculated
  is_brycer_jurisdiction BOOLEAN DEFAULT FALSE,
  brycer_ahj_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CONTRACTS ───
-- Service agreements tied to a location.
CREATE TABLE contracts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id UUID REFERENCES locations(id) NOT NULL,
  billing_account_id UUID REFERENCES billing_accounts(id),
  type TEXT NOT NULL DEFAULT 'recurring', -- 'recurring', 'one-time'
  frequency TEXT, -- 'annual', 'semi-annual', 'quarterly'
  services_included TEXT[], -- ['extinguishers','suppression','elights']
  annual_value DECIMAL(10,2),
  start_date DATE,
  end_date DATE,
  auto_renew BOOLEAN DEFAULT TRUE,
  signed BOOLEAN DEFAULT FALSE,
  signed_at TIMESTAMPTZ,
  signature_data TEXT, -- base64 signature image
  contract_pdf_url TEXT,
  status TEXT DEFAULT 'draft', -- 'draft','active','expired','cancelled'
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── EQUIPMENT: EXTINGUISHERS ───
CREATE TABLE extinguishers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id UUID REFERENCES locations(id) NOT NULL,
  type TEXT NOT NULL, -- 'ABC', 'BC', 'Class K', 'CO2', 'H2O', 'Class D', 'Halotron'
  size TEXT, -- '5lb', '10lb', '20lb', '6L', etc.
  serial_number TEXT,
  manufacturer TEXT,
  location_in_building TEXT, -- 'Kitchen hallway', 'Front entrance', etc.
  manufacture_date DATE,
  last_inspection DATE,
  last_6year DATE,
  last_hydro DATE,
  next_inspection DATE,
  next_6year DATE,
  next_hydro DATE,
  status TEXT DEFAULT 'active', -- 'active','condemned','removed','swapped'
  condemned_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── EQUIPMENT: SUPPRESSION SYSTEMS ───
CREATE TABLE suppression_systems (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id UUID REFERENCES locations(id) NOT NULL,
  system_type TEXT NOT NULL, -- 'Ansul R-102', 'Ansul Piranha', 'Pyro-Chem Kitchen Knight II', 'Buckeye Kitchen Mister', 'Kidde WHDR', 'Captive-Aire Tank', 'Captive-Aire CORE', 'Pyro-Chem Monarch'
  category TEXT NOT NULL, -- 'standard', 'captiveaire_tank', 'captiveaire_core'
  tank_count INTEGER DEFAULT 1,
  nozzle_count INTEGER DEFAULT 0,
  fusible_link_count INTEGER DEFAULT 0,
  detection_type TEXT DEFAULT 'fusible_link', -- 'fusible_link', 'thermo_bulb', 'shielded_cable'
  agent_type TEXT, -- 'Ansulex', 'Pyro-Chem Wet Chemical', 'Buckeye Wet Chemical', 'Kidde APC', 'Dry Chemical'
  cartridge_type TEXT, -- 'LT-10 Nitrogen', 'LT-30 Nitrogen', '16g CO2', 'Buckeye N2 Small', 'Buckeye N2 Large', 'Kidde XV N2'
  cap_type TEXT, -- 'rubber', 'stainless_steel', 'foil_seal'
  location_in_building TEXT, -- 'Main cook line', 'Fryer station', 'Paint booth'
  manufacture_date DATE,
  last_inspection DATE,
  last_hydro DATE,
  next_inspection DATE,
  next_hydro DATE, -- 12-year cycle for tanks
  serial_number TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── EQUIPMENT: EMERGENCY LIGHTS ───
CREATE TABLE emergency_lights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id UUID REFERENCES locations(id) NOT NULL,
  fixture_count INTEGER DEFAULT 0,
  last_annual_test DATE,
  next_annual_test DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── JOBS ───
CREATE TABLE jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id UUID REFERENCES locations(id) NOT NULL,
  billing_account_id UUID REFERENCES billing_accounts(id),
  contract_id UUID REFERENCES contracts(id),
  job_number TEXT UNIQUE, -- auto-generated: SA-2026-0001
  type TEXT NOT NULL DEFAULT 'inspection', -- 'inspection', 'emergency', 'emergency_after_hrs', 'emergency_holiday', 'install', 'repair', 'misc'
  scope TEXT[], -- ['suppression','extinguishers','elights','hydro']
  status TEXT DEFAULT 'scheduled', -- 'scheduled','en_route','active','completed','cancelled','rescheduled'
  scheduled_date DATE,
  scheduled_time TIME,
  route_order INTEGER, -- position in day's route
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  technician TEXT DEFAULT 'Jon Stephens',
  customer_notified_at TIMESTAMPTZ, -- when "on my way" text was sent
  customer_arrived_at TIMESTAMPTZ, -- when "arrived" text was sent
  signature_data TEXT, -- base64 signature
  photos TEXT[], -- array of photo URLs
  travel_distance DOUBLE PRECISION, -- miles from base
  travel_charge DECIMAL(10,2) DEFAULT 0,
  estimated_value DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── JOB RESULTS: EXTINGUISHER INSPECTIONS ───
CREATE TABLE extinguisher_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) NOT NULL,
  extinguisher_id UUID REFERENCES extinguishers(id) NOT NULL,
  status TEXT NOT NULL, -- 'pass', 'swap', 'replace', 'condemn', 'remove'
  condemn_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── JOB RESULTS: SUPPRESSION INSPECTIONS ───
CREATE TABLE suppression_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) NOT NULL,
  suppression_system_id UUID REFERENCES suppression_systems(id) NOT NULL,
  links_replaced BOOLEAN DEFAULT TRUE,
  caps_replaced BOOLEAN DEFAULT TRUE,
  cartridge_checked BOOLEAN DEFAULT FALSE,
  agent_level_ok BOOLEAN DEFAULT TRUE,
  gas_valve_tested BOOLEAN DEFAULT FALSE,
  pull_station_tested BOOLEAN DEFAULT FALSE,
  detection_tested BOOLEAN DEFAULT FALSE,
  piping_inspected BOOLEAN DEFAULT FALSE,
  nozzles_inspected BOOLEAN DEFAULT FALSE,
  deficiencies TEXT[],
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── JOB RESULTS: EMERGENCY LIGHT TESTS ───
CREATE TABLE elight_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) NOT NULL,
  emergency_light_id UUID REFERENCES emergency_lights(id) NOT NULL,
  fixtures_tested INTEGER DEFAULT 0,
  fixtures_passed INTEGER DEFAULT 0,
  fixtures_failed INTEGER DEFAULT 0,
  test_duration_minutes INTEGER DEFAULT 90,
  failed_fixture_details TEXT, -- JSON array of failed fixture locations/reasons
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INVOICES ───
CREATE TABLE invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  location_id UUID REFERENCES locations(id) NOT NULL,
  billing_account_id UUID REFERENCES billing_accounts(id),
  invoice_number TEXT UNIQUE, -- auto-generated: INV-2026-0001
  date TIMESTAMPTZ DEFAULT NOW(),
  due_date DATE,
  status TEXT DEFAULT 'draft', -- 'draft','sent','viewed','paid','overdue','void'
  subtotal DECIMAL(10,2) DEFAULT 0,
  travel_charge DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) DEFAULT 0,
  paid_at TIMESTAMPTZ,
  payment_method TEXT, -- 'card','check','cash','transfer'
  stripe_payment_id TEXT,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INVOICE LINE ITEMS ───
CREATE TABLE invoice_lines (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id UUID REFERENCES invoices(id) NOT NULL,
  description TEXT NOT NULL,
  quantity DECIMAL(10,2) DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── REPORTS (for Brycer and customer portal) ───
CREATE TABLE reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) NOT NULL,
  location_id UUID REFERENCES locations(id) NOT NULL,
  report_type TEXT NOT NULL, -- 'suppression_inspection', 'extinguisher_inspection', 'elight_test', 'install_acceptance', 'deficiency', 'repair'
  brycer_system_type TEXT, -- 'Hood Suppression System', 'Paint/Spray Booth Suppression', etc.
  brycer_template TEXT, -- 'S', 'A', 'D', 'R'
  brycer_submitted BOOLEAN DEFAULT FALSE,
  brycer_submitted_at TIMESTAMPTZ,
  brycer_status TEXT, -- 'pending', 'accepted', 'rejected'
  report_pdf_url TEXT,
  report_data JSONB, -- full report data for regeneration
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── STORE: PRODUCTS (Heiser catalog) ───
CREATE TABLE store_products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  heiser_part_number TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT, -- 'fire_extinguishers', 'system_components', 'accessories', etc.
  wholesale_price DECIMAL(10,2) NOT NULL,
  retail_price DECIMAL(10,2) NOT NULL, -- wholesale + 50%
  image_url TEXT,
  in_stock BOOLEAN DEFAULT TRUE,
  requires_service BOOLEAN DEFAULT FALSE, -- items that can't be sold without on-site service
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── STORE: ORDERS ───
CREATE TABLE store_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_number TEXT UNIQUE, -- auto-generated: SO-2026-0001
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  shipping_address TEXT NOT NULL,
  shipping_city TEXT NOT NULL,
  shipping_state TEXT NOT NULL,
  shipping_zip TEXT NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending','sent_to_heiser','shipped','delivered','cancelled'
  stripe_payment_id TEXT,
  heiser_notified_at TIMESTAMPTZ,
  heiser_order_email_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── STORE: ORDER ITEMS ───
CREATE TABLE store_order_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES store_orders(id) NOT NULL,
  product_id UUID REFERENCES store_products(id) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── VENDOR DOCUMENTS ───
CREATE TABLE vendor_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  document_type TEXT NOT NULL, -- 'w9', 'coi', 'license', 'insurance'
  file_url TEXT NOT NULL,
  file_name TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at DATE,
  active BOOLEAN DEFAULT TRUE
);

-- ─── TECHNICIANS (future multi-tech support) ───
CREATE TABLE technicians (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  license_number TEXT, -- FEL number
  license_type TEXT, -- 'A', 'B'
  role TEXT DEFAULT 'technician', -- 'owner', 'technician', 'office'
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── RATE CARD ───
-- Stored in DB so it's adjustable without code changes
CREATE TABLE rate_card (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default rate card
INSERT INTO rate_card (key, description, price) VALUES
  ('extinguisher_inspection', 'Portable Fire Extinguisher Inspection (per unit)', 20.00),
  ('suppression_standard', 'Fixed Suppression Semi-Annual - Standard (base)', 250.00),
  ('suppression_captiveaire_tank', 'Fixed Suppression Semi-Annual - Captive-Aire Tank (base)', 450.00),
  ('suppression_captiveaire_core', 'Fixed Suppression Semi-Annual - Captive-Aire CORE (base)', 650.00),
  ('suppression_additional_tank', 'Additional Tank (any system type)', 50.00),
  ('emergency_light', 'Emergency Lighting Annual Test (per fixture)', 20.00),
  ('hydro_class_k', 'Hydrostatic Test - Class K (wet chemical)', 275.00),
  ('hydro_co2', 'Hydrostatic Test - CO2', 72.00),
  ('hydro_h2o', 'Hydrostatic Test - H2O', 57.00),
  ('hydro_abc', 'Hydrostatic Test - ABC / Dry Chemical', 68.00),
  ('dry_chem_internal', 'Dry Chemical Internal Inspection', 68.00),
  ('labor_hr', 'Labor Rate (per hour)', 200.00),
  ('fusible_link', 'Fusible Link (per piece)', 25.00),
  ('nozzle', 'Nozzle - any type (per piece)', 92.50),
  ('silicone_cap', 'Silicone Nozzle Cap (per piece)', 9.00),
  ('metal_blowoff_cap', 'High-Temp Metal Blow-Off Cap (per piece)', 25.00),
  ('new_5lb_ext', 'New 5lb Dry Chemical Extinguisher', 102.50),
  ('new_10lb_ext', 'New 10lb Dry Chemical Extinguisher', 141.50),
  ('emergency_call', 'Emergency Service Call', 500.00),
  ('emergency_after_hrs', 'Emergency Service Call - After Hours', 750.00),
  ('emergency_holiday', 'Emergency Service Call - Holiday/Weekend', 1000.00),
  ('travel_rate_hr', 'Travel Rate (per hour, beyond 50mi)', 250.00),
  ('travel_free_radius', 'Free Travel Radius (miles)', 50.00),
  ('travel_mileage_rate', 'Mileage Rate (IRS rate per mile)', 0.70);

-- ─── AUTO-UPDATE TIMESTAMPS ───
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_accounts_updated BEFORE UPDATE ON billing_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER locations_updated BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER contracts_updated BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER extinguishers_updated BEFORE UPDATE ON extinguishers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER suppression_systems_updated BEFORE UPDATE ON suppression_systems FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER emergency_lights_updated BEFORE UPDATE ON emergency_lights FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER jobs_updated BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER invoices_updated BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER store_products_updated BEFORE UPDATE ON store_products FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER store_orders_updated BEFORE UPDATE ON store_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── AUTO-GENERATE JOB NUMBERS ───
CREATE OR REPLACE FUNCTION generate_job_number()
RETURNS TRIGGER AS $$
DECLARE
  year_str TEXT;
  seq_num INTEGER;
BEGIN
  year_str := TO_CHAR(NOW(), 'YYYY');
  SELECT COALESCE(MAX(CAST(SUBSTRING(job_number FROM 9) AS INTEGER)), 0) + 1
    INTO seq_num
    FROM jobs
    WHERE job_number LIKE 'SA-' || year_str || '-%';
  NEW.job_number := 'SA-' || year_str || '-' || LPAD(seq_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_auto_number BEFORE INSERT ON jobs FOR EACH ROW WHEN (NEW.job_number IS NULL) EXECUTE FUNCTION generate_job_number();

-- ─── AUTO-GENERATE INVOICE NUMBERS ───
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  year_str TEXT;
  seq_num INTEGER;
BEGIN
  year_str := TO_CHAR(NOW(), 'YYYY');
  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 10) AS INTEGER)), 0) + 1
    INTO seq_num
    FROM invoices
    WHERE invoice_number LIKE 'INV-' || year_str || '-%';
  NEW.invoice_number := 'INV-' || year_str || '-' || LPAD(seq_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_auto_number BEFORE INSERT ON invoices FOR EACH ROW WHEN (NEW.invoice_number IS NULL) EXECUTE FUNCTION generate_invoice_number();

-- ─── AUTO-GENERATE STORE ORDER NUMBERS ───
CREATE OR REPLACE FUNCTION generate_store_order_number()
RETURNS TRIGGER AS $$
DECLARE
  year_str TEXT;
  seq_num INTEGER;
BEGIN
  year_str := TO_CHAR(NOW(), 'YYYY');
  SELECT COALESCE(MAX(CAST(SUBSTRING(order_number FROM 9) AS INTEGER)), 0) + 1
    INTO seq_num
    FROM store_orders
    WHERE order_number LIKE 'SO-' || year_str || '-%';
  NEW.order_number := 'SO-' || year_str || '-' || LPAD(seq_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER store_orders_auto_number BEFORE INSERT ON store_orders FOR EACH ROW WHEN (NEW.order_number IS NULL) EXECUTE FUNCTION generate_store_order_number();

-- ─── INDEXES FOR PERFORMANCE ───
CREATE INDEX idx_locations_billing ON locations(billing_account_id);
CREATE INDEX idx_extinguishers_location ON extinguishers(location_id);
CREATE INDEX idx_suppression_location ON suppression_systems(location_id);
CREATE INDEX idx_elights_location ON emergency_lights(location_id);
CREATE INDEX idx_jobs_location ON jobs(location_id);
CREATE INDEX idx_jobs_date ON jobs(scheduled_date);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_billing ON invoices(billing_account_id);
CREATE INDEX idx_reports_job ON reports(job_id);
CREATE INDEX idx_contracts_location ON contracts(location_id);
CREATE INDEX idx_store_products_category ON store_products(category);
CREATE INDEX idx_store_orders_status ON store_orders(status);
