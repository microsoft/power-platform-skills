# IT Portfolio Management Canvas App
## Implementation Guide

### Phase 1: Environment Preparation

#### Step 1.1: Verify Dataverse Tables
Before starting, confirm all 10 required tables exist in the Dataverse environment:

\\\
Environment: itportfoliomgmt-dev.crm.dynamics.com

Required Tables:
✓ kait_application
✓ kait_vendor
✓ kait_contract
✓ kait_contractdocument
✓ kait_budgethistory
✓ kait_department
✓ kait_entity
✓ kait_notificationgroup
✓ kait_applicationallocation
✓ kait_applicationallocationsummary
\\\

**Validation Script** (Power Fx):
\\\
ShowColumns(
  Filter(
    Table({TableName: "kait_application"}, {TableName: "kait_vendor"}, {TableName: "kait_contract"}),
    true
  ),
  "TableName"
)
\\\

#### Step 1.2: Verify Data Columns
For each table, confirm these critical columns exist:

**kait_application**
- kait_applicationid (Primary key)
- kait_applicationname
- kait_category
- kait_applicationtype
- kait_description
- kait_vendor
- kait_businessowner
- kait_owningdepartment
- kait_status
- kait_criticality
- kait_startdate
- kait_enddate

**kait_contract**
- kait_contractid
- kait_contractname
- kait_vendor
- kait_contracttype
- kait_startdate
- kait_enddate
- kait_renewaldate
- kait_contractamount
- kait_autorenewal
- kait_status

**kait_contractdocument**
- kait_contractdocumentid
- kait_documentname
- kait_contractid
- kait_documenttype
- kait_uploaddate
- kait_version
- kait_fileuri
- kait_downloaduri

#### Step 1.3: Set Security Roles
Ensure users have appropriate Dataverse roles:

| Role | Tables | Permissions |
|------|--------|-------------|
| IT Portfolio Manager | All 10 | Create, Read, Update, Delete |
| Financial Analyst | Budget, Allocation | Read, Update |
| Department Manager | Application, Budget (own dept) | Read |
| Executive | All 10 | Read |
| Vendor Manager | Vendor, Contract | Create, Read, Update |

### Phase 2: Canvas App Creation

#### Step 2.1: Create New Canvas App
1. Navigate to https://make.powerapps.com
2. Select **itportfoliomgmt-dev** environment
3. Click **Create** → **Blank canvas app**
4. Name: "IT Portfolio Management"
5. Format: **Tablet** (10" recommended for dashboards)
6. Click **Create**

#### Step 2.2: Add Data Connections
In Power Apps Studio:
1. Click **Data** in left panel
2. Click **+ Add data**
3. Search for each table:
   - kait_application
   - kait_vendor
   - kait_contract
   - kait_contractdocument
   - kait_budgethistory
   - kait_department
   - kait_entity
   - kait_notificationgroup
   - kait_applicationallocation
   - kait_applicationallocationsummary
4. Click **Connect** for each

#### Step 2.3: Create App Shell
Add a navigation control for tab-based navigation:

1. Insert **Tab List** control
2. Rename to: 	abNavigation
3. Set **Items** property:
   \\\
   Table(
     {id: 1, label: "Home", icon: "Home"},
     {id: 2, label: "Applications", icon: "ListView"},
     {id: 3, label: "Vendors", icon: "Building"},
     {id: 4, label: "Contracts", icon: "DocumentSet"},
     {id: 5, label: "Renewals", icon: "Calendar"},
     {id: 6, label: "Budget", icon: "BarChart"},
     {id: 7, label: "Allocation", icon: "PieChart"}
   )
   \\\
4. Create a global variable for tab tracking:
   \\\
   Set(varCurrentTab, tabNavigation.Selected.id)
   \\\

### Phase 3: Screen Implementation

#### Screen 1: Home Dashboard
**Controls to Add:**
1. Header
   - Control Type: HTML text with styling
   - Text: "IT Portfolio Management"

2. KPI Cards (Use containers, 2x2 grid)
   - Total Applications: 
     \\\
     CountRows(Filter(kait_application, kait_status="Active"))
     \\\
   - Active Contracts:
     \\\
     CountRows(Filter(kait_contract, kait_status="Active"))
     \\\
   - Total Vendors:
     \\\
     CountRows(kait_vendor)
     \\\
   - Annual Spend:
     \\\
     Sum(kait_contract, kait_contractamount)
     \\\

3. Renewal Alerts
   - Data Table: Filter(kait_contract, And(kait_renewaldate<=Today()+30, kait_renewaldate>=Today()))
   - Sort: kait_renewaldate ascending
   - Columns to show: Contract Name, Vendor, Expiration Date, Days Remaining

4. Quick Navigation Buttons
   - 4 buttons in a row
   - Navigate to Applications, Vendors, Contracts, Renewals screens
   - Use Icon properties for visual appeal

#### Screen 2: Application Portfolio
**Controls to Add:**

1. Search Box
   \\\
   SearchApplications.Value
   
   // Use in Gallery filter:
   Filter(
     kait_application,
     If(IsBlank(SearchApplications.Value), 
       true, 
       Or(
         Search(SearchApplications.Value, kait_applicationname),
         Search(SearchApplications.Value, kait_vendor),
         Search(SearchApplications.Value, kait_category)
       )
     )
   )
   \\\

2. Filter Controls (Dropdowns in horizontal container)
   - Status: Dropdown with Items = ["Active", "Planned", "Retired", "Under Review"]
   - Department: Dropdown with Items = kait_department
   - Criticality: Dropdown with Items = ["Critical", "High", "Medium", "Low"]

3. Application Gallery
   \\\
   Gallery (Vertical, scrollable):
   Items = Filter(
     kait_application,
     And(
       If(IsBlank(DropStatus.Value), true, kait_status=DropStatus.Value),
       If(IsBlank(DropDepartment.Value), true, kait_owningdepartment=DropDepartment.Value),
       If(IsBlank(DropCriticality.Value), true, kait_criticality=DropCriticality.Value),
       If(IsBlank(SearchApplications.Value), true, 
         Or(
           Search(SearchApplications.Value, kait_applicationname),
           Search(SearchApplications.Value, kait_vendor)
         )
       )
     )
   )
   
   Template Layout:
   - Title: kait_applicationname (Bold, 18pt)
   - Vendor: kait_vendor
   - Status: kait_status (color-coded)
   - Department: kait_owningdepartment
   - Criticality Badge: kait_criticality
   
   OnSelect = Set(varSelectedApplication, ThisRecord())
   \\\

4. Detail Panel (Hidden by default, show on gallery select)
   - Application Name
   - Vendor
   - Category
   - Type
   - Status
   - Criticality
   - Business Owner
   - Owning Department
   - Start Date
   - End Date
   - Description (Text wrap)

#### Screen 3: Vendor Management
**Similar structure to Applications:**

1. Search Box for vendor name/industry
2. Vendor Gallery with Cards
   - Company Name (Bold)
   - Industry
   - Contact Email
   - Active Contracts Count
   - Total Contract Value

3. Vendor Detail Panel
   - Contact Information
   - Associated Applications (Sub-gallery)
   - Associated Contracts (Sub-gallery)
   - Payment Terms
   - Performance Rating

#### Screen 4: Contract Management
**Advanced Filtering with Status Colors:**

1. Filter Controls
   - Status: ["Active", "Expired", "Renewal Pending"]
   - Vendor: Dropdown from kait_vendor
   - Type: ["Software License", "SaaS", "Maintenance", "Support"]
   - Renewal Date Range: Date pickers

2. Contract Gallery
   \\\
   Items = Filter(
     kait_contract,
     And(
       If(IsBlank(DropStatus.Value), true, kait_status=DropStatus.Value),
       If(IsBlank(DropVendor.Value), true, kait_vendor=DropVendor.Value),
       If(IsBlank(DropType.Value), true, kait_contracttype=DropType.Value)
     )
   )
   
   Template:
   - Contract Name (Bold)
   - Vendor
   - Amount (formatted as currency)
   - Expiration Date
   - Status Badge (colored):
     * Red if Days(Today(), kait_renewaldate) < 14
     * Orange if < 30
     * Yellow if < 90
   \\\

3. Contract Detail Form
   - All contract fields
   - Associated Documents (Sub-gallery)
   - Associated Applications (Sub-gallery)
   - Department Allocations (Sub-gallery)
   - Renewal status calculation

#### Screen 5: Document Viewer
**PDF Viewing:**

1. Document Metadata
   - Document Name
   - Document Type
   - Upload Date
   - Version

2. PDF Viewer Control
   - Control: PowerAppsComponent (PDF Viewer)
   - Document URI: varSelectedDocument.kait_fileuri

3. Action Buttons
   - Download: Launch(varSelectedDocument.kait_downloaduri)
   - Back: Navigate to Contract Detail

#### Screen 6: Renewal Dashboard
**90-Day Focus with Urgency:**

1. Alert Banner
   - Condition: If contracts expiring < 14 days exist
   - Message: "URGENT: X contracts expire in next 14 days"
   - Color: Red background

2. Renewal Grid
   \\\
   DataTable Items:
   Filter(
     kait_contract,
     And(
       kait_renewaldate <= Today() + 90,
       kait_renewaldate >= Today()
     )
   )
   
   Columns:
   - Contract Name
   - Vendor
   - Expiration Date (formatted mm/dd/yyyy)
   - Days Remaining: Text(Days(kait_renewaldate, Today()), "0")
   - Status (Red/Orange/Yellow based on days)
   - Amount (formatted as currency)
   
   Sort: kait_renewaldate (ascending)
   \\\

3. Monthly Renewal Chart
   - Column Chart
   - X-axis: Month(kait_renewaldate)
   - Y-axis: Sum(kait_contractamount) by month
   - Shows spending distribution across renewal months

4. Department Filter
   - Optional: Filter by department for department-specific renewals

#### Screen 7: Budget Analysis
**Multi-Year Comparison:**

1. Filter Controls
   - Year: Dropdown (dynamic years from kait_budgethistory)
   - Department: Dropdown (optional filter)

2. Budget vs Actual Chart
   - Type: Clustered Column Chart
   - X-axis: kait_department
   - Series 1: kait_budgetamount
   - Series 2: kait_actualamount

3. Variance Analysis Table
   \\\
   DataTable:
   Filter(
     kait_budgethistory,
     Year(kait_yeardate) = SelectedYear.Value
   )
   
   Columns:
   - Application
   - Department
   - Budget: Text(kait_budgetamount, "\$#,##0.00")
   - Actual: Text(kait_actualamount, "\$#,##0.00")
   - Variance: Text(kait_budgetamount - kait_actualamount, "\$#,##0.00")
   - Variance %: Text((kait_budgetamount - kait_actualamount) / kait_budgetamount, "0.0%")
   \\\

#### Screen 8: Cost Allocation
**Department-Level Breakdown:**

1. Allocation Overview Pie Chart
   - Segments: By department
   - Values: Sum of allocations
   - Shows department cost distribution

2. Department Allocation Table
   \\\
   DataTable:
   kait_applicationallocation
   
   Columns:
   - Application
   - Department
   - Allocation Method
   - Allocation %: Text(kait_allocationpercentage, "0.0%")
   - Allocation Amount: Text(kait_allocationamount, "\$#,##0.00")
   \\\

3. Year Selector
   - Filter allocation data by fiscal year

### Phase 4: Advanced Features

#### Feature 1: Status Color Coding
Create a reusable function for status colors:

\\\
// Formula for renewal urgency color
GetRenewalColor = If(
  Days(Today(), RenewalDate) < 14, 
  Color.Red,
  If(Days(Today(), RenewalDate) < 30, 
    Color.Orange,
    If(Days(Today(), RenewalDate) < 90, 
      Color.Yellow, 
      Color.Green
    )
  )
)

// Use in Shape Fill: GetRenewalColor(kait_renewaldate)
\\\

#### Feature 2: Search Across Multiple Fields
\\\
// Global search function
GlobalSearch = Function({searchTerm},
  If(
    IsBlank(searchTerm),
    Blank(),
    Or(
      Search(searchTerm, kait_applicationname),
      Search(searchTerm, kait_vendor),
      Search(searchTerm, kait_description),
      Search(searchTerm, kait_contractname)
    )
  )
);
\\\

#### Feature 3: Calculated Renewal Status
\\\
// Add to Contract records (via Power Fx or Model-driven form)
RenewalStatus = If(
  IsBlank(kait_renewaldate),
  "No Renewal Date",
  If(
    kait_renewaldate < Today(),
    "EXPIRED",
    If(
      Days(kait_renewaldate, Today()) <= 14,
      "URGENT",
      If(
        Days(kait_renewaldate, Today()) <= 30,
        "SOON",
        If(
          Days(kait_renewaldate, Today()) <= 90,
          "UPCOMING",
          "ON TRACK"
        )
      )
    )
  )
)
\\\

#### Feature 4: Department Cost Summary
\\\
// Create summary gallery for department costs
Filter(
  AddColumns(
    Distinct(kait_applicationallocation, kait_department),
    "TotalAllocated", Sum(
      Filter(
        kait_applicationallocation,
        kait_department = Value
      ),
      kait_allocationamount
    )
  ),
  true
)
\\\

### Phase 5: Testing & Validation

#### Test Cases

| Test | Expected Result | Pass/Fail |
|------|-----------------|-----------|
| Open home dashboard | All KPI cards load without errors | [ ] |
| Search applications | Results filtered correctly | [ ] |
| Filter by status | Only selected status applications shown | [ ] |
| View contract detail | All contract fields display | [ ] |
| View PDF contract | PDF renders in viewer | [ ] |
| Download contract | File downloads successfully | [ ] |
| Renewal dashboard | Only contracts within 90 days shown | [ ] |
| Renewal alerts | Red alert for <14 days | [ ] |
| Budget chart | Budget vs actual compares correctly | [ ] |
| Cost allocation pie | Segments sum to 100% | [ ] |
| Navigate screens | All tab navigation works | [ ] |
| Mobile view | App responsive on tablet | [ ] |

#### Performance Testing
- Load time for application gallery with 500+ records
- Search response time
- PDF viewer loading with large documents
- Chart rendering with 12+ months of data

### Phase 6: Deployment

#### Pre-Deployment Checklist
- [ ] All tables verified and accessible
- [ ] Security roles assigned to test users
- [ ] All screens tested thoroughly
- [ ] Navigation flows validated
- [ ] Data filters working correctly
- [ ] PDF viewer functional
- [ ] Charts rendering properly
- [ ] Mobile responsiveness checked

#### Deployment Steps
1. Save and Publish the app in Power Apps Studio
2. Grant share/use permissions to security groups:
   - IT Portfolio Managers (Full Access)
   - Accountants (Read Most, Edit Budget/Allocation)
   - Department Leads (Read Own Department)
   - Executives (Read All)
3. Create app tile in Power Apps Home
4. Send user documentation and training materials
5. Monitor usage and gather feedback
6. Plan for ongoing maintenance and enhancements

### Phase 7: Post-Deployment (First 30 Days)

#### Week 1
- Monitor for data connection issues
- Gather user feedback on UX
- Fix any broken filters or calculations
- Optimize slow-loading screens

#### Week 2
- Implement user-requested tweaks
- Add missing columns to galleries
- Improve error handling
- Create user guide documentation

#### Week 3
- Performance optimization
- Security audit
- Backup application version
- Plan Phase 2 enhancements

#### Week 4
- Fully transition to production support
- Establish SLA for issue response
- Plan Power Automate workflow for renewals
- Design Power BI dashboard to complement app

### Next Steps: Power Automate Integration

#### Renewal Notification Workflow
Once Canvas app is stable, implement Power Automate for:
- 180-day renewal notifications
- 90-day renewals
- 60-day renewals
- 30-day renewals (critical)
- 14-day renewals (urgent)
- 7-day renewals (final notice)

Recipients: From kait_notificationgroup linked to contract

---

**Estimated Effort**: 40-60 hours (development + testing)  
**Timeline**: 2-3 weeks  
**Go-Live Date**: Target end of Sprint  
