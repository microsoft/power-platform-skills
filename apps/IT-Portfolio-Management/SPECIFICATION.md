# IT Portfolio Management Canvas Application Specification
# Organization: Kraus-Anderson
# Environment: itportfoliomgmt-dev.crm.dynamics.com
# Date: 2026-09-02

## Application Overview
Enterprise IT Application Portfolio and Contract Management Solution

## Data Connections
- Dataverse Environment: https://itportfoliomgmt-dev.crm.dynamics.com
- Tables Used:
  - kait_application (Application Portfolio)
  - kait_vendor (Vendor Master)
  - kait_contract (Contract Management)
  - kait_contractdocument (Document Storage)
  - kait_budgethistory (Budget Tracking)
  - kait_department (Departments)
  - kait_entity (Business Entities)
  - kait_notificationgroup (Renewal Notifications)
  - kait_applicationallocation (Cost Allocation)
  - kait_applicationallocationsummary (Allocation Summary)

## Screen Architecture

### Screen 1: Home Dashboard
- KPI Cards: Total Applications | Active Contracts | Vendor Count | Annual Spend
- Renewal Alert Widget: Contracts Expiring in 30 Days
- Quick Stats by Department
- Navigation to all major modules

### Screen 2: Application Portfolio
- Master-Detail View with Gallery
- Search Bar (searches Name, Category, Type, Description)
- Filter Controls:
  * Status (Active, Planned, Retired, Under Review)
  * Category
  * Business Owner
  * Owning Department
  * Business Criticality
- Detail Form with Sections:
  * Basic Info (Name, Category, Type, Description)
  * Vendor & Owner (Vendor, Business Owner, Department)
  * Lifecycle (Status, Criticality, Start Date, End Date)
  * Associated Contracts
  * Cost Allocation Breakdown

### Screen 3: Vendor Management
- Vendor Directory Gallery with Search
- Filter by Industry, Region, Contract Count
- Vendor Detail Form:
  * Contact Information
  * Associated Applications
  * Associated Contracts
  * Payment Terms
  * Performance Rating

### Screen 4: Contract Management
- Contract List Gallery with Search
- Filter Controls:
  * Status (Active, Expired, Renewal Pending)
  * Vendor
  * Application
  * Department
  * Renewal Date Range
- Contract Detail Form:
  * Agreement Details (Type, Start Date, End Date, Renewal Date)
  * Financial (Amount, Payment Terms, Auto-Renewal Status)
  * Associated Vendor, Applications, Departments
  * Attached Documents
- Renewal Status Indicator (Days until renewal)

### Screen 5: Contract Document Viewer
- Document List for Selected Contract
- Document Metadata (Type, Upload Date, Version)
- PDF Viewer Control (embedded)
- Download Capability
- Version History

### Screen 6: Renewal Dashboard (90-Day Focus)
- High-Priority Alerts (Expiring in 14-30 Days)
- Upcoming Renewals Grid:
  * Contract Name | Vendor | Expiration Date | Days Remaining | Status | Action
- Filter by Department, Notification Group
- Quick Actions: Mark Renewed | Extend Date | Send Notification
- Renewal Summary Stats

### Screen 7: Budget Analysis
- Budget vs Actual by Department (Chart)
- Budget vs Actual by Application (Sortable List)
- Variance Analysis (amount and percentage)
- Multi-Year Comparison
- Drill-down to Application Details

### Screen 8: Cost Allocation
- Allocation Overview by Department
- Allocation by Application
- Allocation Method Breakdown (User Count, License Count, Manual %)
- Year Filter
- Department-wise Cost Breakdown Gallery
- Cost Trending

### Screen 9: Settings & Administration
- Role-Based Access Control
- Notification Group Management
- Renewal Notification Preferences (Days: 180, 90, 60, 30, 14, 7)
- Export & Reporting Options

## Key Formulas & Business Logic

### Renewal Status Calculation
- Days Until Renewal = RenewalDate - Today()
- Status Labels:
  * "URGENT" if Days < 14
  * "SOON" if Days < 30
  * "UPCOMING" if Days < 90
  * "ON TRACK" if Days >= 90

### Budget Variance
- Variance Amount = Budget Amount - Actual Amount
- Variance % = (Variance Amount / Budget Amount) * 100

### Cost Allocation Calculation
- Total Allocated = SUM(Department Allocations)
- Department Share = (Department Allocation / Total) * Contract Amount

## Color Scheme & UX
- Primary: Kraus-Anderson Brand Color (TBD)
- Status Colors:
  * Green: Active, On Track
  * Yellow: Upcoming (30-90 days)
  * Orange: Soon (14-30 days)
  * Red: Urgent (<14 days), Expired
- Clean, Executive-Friendly Interface
- Mobile Responsive
- Accessible (WCAG 2.1 AA)

## Navigation Structure
- Main App Shell with Tab Navigation
- Breadcrumb Trail on Detail Screens
- Back/Forward Navigation
- Search Global Scope Option
- Context-Aware Help

## Reporting & Export
- Export to Excel (Application List, Contract List, Budget Report)
- PDF Export of Contracts
- Scheduled Email Reports
- Dashboard Snapshots

## Security & Permissions
- Dataverse Role-Based Access (Inherited from CRM)
- Field-Level Security Where Applicable
- Audit Trail for Contract Changes
- Document Access Control
