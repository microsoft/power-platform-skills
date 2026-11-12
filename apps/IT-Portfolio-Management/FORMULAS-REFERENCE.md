# Power Fx Formula Reference
## IT Portfolio Management Canvas App

### Global Variables & Functions

#### Session Setup
\\\powerfx
// Initialize on app startup
Set(varCurrentUser, User().Email);
Set(varTodayDate, Today());
Set(varCurrentTab, 1);
Set(varSearchText, "");

// Track selected records
Set(varSelectedApplication, Blank());
Set(varSelectedContract, Blank());
Set(varSelectedVendor, Blank());
Set(varSelectedDocument, Blank());
\\\

### Screen 1: Home Dashboard - Formulas

#### KPI: Total Applications
\\\powerfx
// Count of active applications
CountRows(Filter(kait_application, kait_status = "Active"))

// Alternative: Count all applications regardless of status
CountRows(kait_application)
\\\

#### KPI: Active Contracts
\\\powerfx
CountRows(Filter(kait_contract, kait_status = "Active"))
\\\

#### KPI: Vendor Count
\\\powerfx
CountRows(kait_vendor)
\\\

#### KPI: Annual Software Spend
\\\powerfx
// Sum of all contract amounts
Sum(kait_contract, kait_contractamount)

// Alternative: Only active contracts
Sum(
  Filter(kait_contract, kait_status = "Active"),
  kait_contractamount
)
\\\

#### Contracts Expiring in 30 Days
\\\powerfx
Filter(
  kait_contract,
  And(
    kait_renewaldate <= Today() + 30,
    kait_renewaldate >= Today()
  )
)

// For sorting (earliest first):
Sort(
  Filter(
    kait_contract,
    And(
      kait_renewaldate <= Today() + 30,
      kait_renewaldate >= Today()
    )
  ),
  kait_renewaldate
)
\\\

### Screen 2: Application Portfolio - Formulas

#### Master Gallery Data Source
\\\powerfx
// Complete filter with search and all dropdown filters
Filter(
  kait_application,
  And(
    // Search filter - checks multiple fields
    If(
      IsBlank(SearchApplications.Value),
      true,
      Or(
        Search(SearchApplications.Value, kait_applicationname),
        Search(SearchApplications.Value, kait_vendor),
        Search(SearchApplications.Value, kait_category),
        Search(SearchApplications.Value, kait_description)
      )
    ),
    // Status filter
    If(
      IsBlank(DropStatus.Value),
      true,
      kait_status = DropStatus.Value
    ),
    // Department filter
    If(
      IsBlank(DropDepartment.Value),
      true,
      kait_owningdepartment = DropDepartment.Value
    ),
    // Criticality filter
    If(
      IsBlank(DropCriticality.Value),
      true,
      kait_criticality = DropCriticality.Value
    )
  )
)
\\\

#### Criticality Badge Color
\\\powerfx
// Used in gallery template to color-code criticality
If(
  kait_criticality = "Critical",
  Color.Red,
  If(
    kait_criticality = "High",
    Color.Orange,
    If(
      kait_criticality = "Medium",
      Color.Yellow,
      Color.Green
    )
  )
)
\\\

#### Status Badge Color
\\\powerfx
// Color for application status
If(
  kait_status = "Active",
  Color.Green,
  If(
    kait_status = "Retired",
    Color.Red,
    If(
      kait_status = "Planned",
      Color.Blue,
      Color.Orange  // Under Review
    )
  )
)
\\\

#### Associated Contracts Sub-Gallery
\\\powerfx
// Show all contracts for selected application
Filter(
  kait_contract,
  kait_applicationid = varSelectedApplication.kait_applicationid
)
\\\

#### Cost Allocation Sub-Gallery
\\\powerfx
// Show allocation breakdown by department
Filter(
  kait_applicationallocation,
  kait_applicationid = varSelectedApplication.kait_applicationid
)
\\\

### Screen 3: Vendor Management - Formulas

#### Vendor Gallery Filter
\\\powerfx
Filter(
  kait_vendor,
  If(
    IsBlank(SearchVendors.Value),
    true,
    Or(
      Search(SearchVendors.Value, kait_vendorname),
      Search(SearchVendors.Value, kait_industry),
      Search(SearchVendors.Value, kait_contactemail)
    )
  )
)
\\\

#### Contract Count for Vendor
\\\powerfx
// Shows in vendor card
CountRows(
  Filter(
    kait_contract,
    kait_vendor = ThisRecord.kait_vendorname
  )
)
\\\

#### Total Spend by Vendor
\\\powerfx
// Sum of all contract amounts for this vendor
Sum(
  Filter(
    kait_contract,
    kait_vendor = ThisRecord.kait_vendorname
  ),
  kait_contractamount
)
\\\

#### Associated Applications Sub-Gallery
\\\powerfx
Filter(
  kait_application,
  kait_vendor = varSelectedVendor.kait_vendorname
)
\\\

### Screen 4: Contract Management - Formulas

#### Master Gallery with Advanced Filtering
\\\powerfx
Sort(
  Filter(
    kait_contract,
    And(
      // Search across contract name, vendor, application
      If(
        IsBlank(SearchContracts.Value),
        true,
        Or(
          Search(SearchContracts.Value, kait_contractname),
          Search(SearchContracts.Value, kait_vendor),
          Search(SearchContracts.Value, kait_applicationid)
        )
      ),
      // Status filter
      If(
        IsBlank(DropContractStatus.Value),
        true,
        kait_status = DropContractStatus.Value
      ),
      // Vendor filter
      If(
        IsBlank(DropVendor.Value),
        true,
        kait_vendor = DropVendor.Value
      ),
      // Contract Type filter
      If(
        IsBlank(DropContractType.Value),
        true,
        kait_contracttype = DropContractType.Value
      )
    )
  ),
  kait_renewaldate  // Sort by renewal date ascending
)
\\\

#### Renewal Status Badge (Multi-Color)
\\\powerfx
// Status text
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

// Status color
If(
  kait_renewaldate < Today(),
  Color.DarkRed,
  If(
    Days(kait_renewaldate, Today()) <= 14,
    Color.Red,
    If(
      Days(kait_renewaldate, Today()) <= 30,
      Color.Orange,
      If(
        Days(kait_renewaldate, Today()) <= 90,
        Color.Yellow,
        Color.Green
      )
    )
  )
)
\\\

#### Days Until Renewal
\\\powerfx
// Calculated column in gallery
Text(
  Days(kait_renewaldate, Today()),
  "0"
) & " days"

// Alternative with conditional text
If(
  kait_renewaldate < Today(),
  "OVERDUE " & Text(Days(Today(), kait_renewaldate), "0") & " days",
  Text(Days(kait_renewaldate, Today()), "0") & " days remaining"
)
\\\

#### Contract Amount Formatting
\\\powerfx
Text(kait_contractamount, "\$#,##0.00")
\\\

### Screen 5: Contract Detail - Formulas

#### Associated Applications Sub-Gallery
\\\powerfx
Filter(
  kait_application,
  kait_contractid = varSelectedContract.kait_contractid
)
\\\

#### Department Allocations Sub-Gallery
\\\powerfx
Filter(
  kait_applicationallocation,
  kait_contractid = varSelectedContract.kait_contractid
)
\\\

#### Allocation Amount Calculation
\\\powerfx
// Allocated amount per department
kait_allocationpercentage / 100 * varSelectedContract.kait_contractamount
\\\

### Screen 6: Renewal Dashboard - Formulas

#### Alert Banner Visibility
\\\powerfx
// Show if any contracts expire in next 14 days
CountRows(
  Filter(
    kait_contract,
    And(
      kait_renewaldate <= Today() + 14,
      kait_renewaldate > Today()
    )
  )
) > 0
\\\

#### Alert Message
\\\powerfx
"⚠️ URGENT: " & 
CountRows(
  Filter(
    kait_contract,
    And(
      kait_renewaldate <= Today() + 14,
      kait_renewaldate > Today()
    )
  )
) & 
" contracts expire in the next 14 days!"
\\\

#### 90-Day Renewal Contracts
\\\powerfx
Sort(
  Filter(
    kait_contract,
    And(
      kait_renewaldate <= Today() + 90,
      kait_renewaldate > Today()
    )
  ),
  kait_renewaldate  // Sort by closest expiration first
)
\\\

#### Renewal Summary by Month (for chart)
\\\powerfx
// Group contracts by renewal month
GroupBy(
  Filter(
    kait_contract,
    And(
      kait_renewaldate <= Today() + 90,
      kait_renewaldate > Today()
    )
  ),
  Month(kait_renewaldate),
  "Month"
)

// For chart, calculate sum by month:
// X-axis: Month(kait_renewaldate)
// Y-axis: Sum(kait_contractamount) grouped by month
\\\

### Screen 7: Budget Analysis - Formulas

#### Unique Years in Budget History
\\\powerfx
// For year dropdown
Distinct(kait_budgethistory, Year(kait_yeardate))

// Alternative with sorted results:
Sort(
  Distinct(kait_budgethistory, Year(kait_yeardate)),
  Value,
  Descending
)
\\\

#### Budget Data Filtered by Year
\\\powerfx
Filter(
  kait_budgethistory,
  Year(kait_yeardate) = Value(DropBudgetYear.Value)
)
\\\

#### Budget Data Filtered by Year & Department
\\\powerfx
Filter(
  kait_budgethistory,
  And(
    Year(kait_yeardate) = Value(DropBudgetYear.Value),
    If(
      IsBlank(DropBudgetDepartment.Value),
      true,
      kait_department = DropBudgetDepartment.Value
    )
  )
)
\\\

#### Variance Calculation
\\\powerfx
// Variance amount
kait_budgetamount - kait_actualamount

// Variance percentage
(kait_budgetamount - kait_actualamount) / kait_budgetamount

// Formatted for display
"Variance: " & Text(kait_budgetamount - kait_actualamount, "\$#,##0.00") & 
" (" & Text((kait_budgetamount - kait_actualamount) / kait_budgetamount, "0.0%") & ")"
\\\

#### Variance Color Coding
\\\powerfx
// Green if under budget, red if over budget
If(
  (kait_budgetamount - kait_actualamount) >= 0,
  Color.Green,    // Under budget (favorable)
  Color.Red       // Over budget (unfavorable)
)
\\\

### Screen 8: Cost Allocation - Formulas

#### Allocation by Department (Pie Chart)
\\\powerfx
// Sum allocations by department
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
  TotalAllocated > 0
)

// X-axis: kait_department
// Y-axis: TotalAllocated
\\\

#### Allocation Table
\\\powerfx
// Show all allocations, optionally filtered
Filter(
  kait_applicationallocation,
  If(
    IsBlank(DropAllocationApp.Value),
    true,
    kait_applicationid = DropAllocationApp.Value
  )
)
\\\

#### Total Allocated Percentage
\\\powerfx
// Verify allocations sum to 100% per application
Sum(
  Filter(
    kait_applicationallocation,
    kait_applicationid = ThisRecord.kait_applicationid
  ),
  kait_allocationpercentage
)
\\\

### Utility Formulas

#### Check if Record is Overdue
\\\powerfx
IsOverdue = kait_renewaldate < Today()
\\\

#### Calculate Business Days Until Renewal
\\\powerfx
// Using business day calculation (excludes weekends)
// Note: Power Fx has limited built-in business day functions
// For Production, may need Power Automate or custom connector

// Simple approach - just calendar days:
Days(kait_renewaldate, Today())
\\\

#### Multi-Field Search Function
\\\powerfx
// Reusable search across multiple fields
SearchMultiple = Function(
  {searchTerm, field1, field2, field3},
  If(
    IsBlank(searchTerm),
    true,
    Or(
      Search(searchTerm, field1),
      Search(searchTerm, field2),
      Search(searchTerm, field3)
    )
  )
)

// Usage:
SearchMultiple(
  SearchBox.Value,
  kait_applicationname,
  kait_vendor,
  kait_description
)
\\\

#### Currency Formatting
\\\powerfx
// Consistent currency display
Text(amount, "\$#,##0.00")

// With negative number formatting:
Text(amount, "\$#,##0.00;-\$#,##0.00")
\\\

#### Date Formatting
\\\powerfx
// Standard date format
Text(date, "mm/dd/yyyy")

// With time:
Text(dateTime, "mm/dd/yyyy hh:mm AM/PM")

// Relative date (e.g., "2 days from now"):
If(
  date < Today(),
  Text(Days(Today(), date), "0") & " days ago",
  Text(Days(date, Today()), "0") & " days from now"
)
\\\

#### Conditional Visibility
\\\powerfx
// Show element only if user is in IT Portfolio Manager role
User().Department = "IT" And User().Title = "Portfolio Manager"

// Or based on app role:
// Access through security roles stored in Dataverse
\\\

### Navigation Formulas

#### Tab Navigation OnSelect
\\\powerfx
// When tab is clicked
Set(varCurrentTab, tabNavigation.Selected.id);

// Navigate based on tab ID
If(
  varCurrentTab = 1, Navigate(scrHome),
  If(varCurrentTab = 2, Navigate(scrApplicationPortfolio),
  If(varCurrentTab = 3, Navigate(scrVendorManagement),
  If(varCurrentTab = 4, Navigate(scrContractManagement),
  If(varCurrentTab = 5, Navigate(scrRenewalDashboard),
  If(varCurrentTab = 6, Navigate(scrBudgetAnalysis),
  If(varCurrentTab = 7, Navigate(scrCostAllocation), Blank()
  )))))))
\\\

#### Gallery Row Selection
\\\powerfx
// When user clicks a gallery item
Set(varSelectedApplication, ThisRecord());
Navigate(scrApplicationDetail)
\\\

#### Back Button
\\\powerfx
Navigate(Screen.Parent, ScreenTransition.Fade)

// Or go back to specific screen:
Navigate(scrApplicationPortfolio)
\\\

### Performance Optimization

#### Indexed Search (for large datasets)
\\\powerfx
// Instead of searching all records, filter first then search
Filter(
  Filter(
    kait_application,
    kait_status = "Active"  // Narrow first
  ),
  Search(SearchBox.Value, kait_applicationname)  // Then search narrowed set
)
\\\

#### Delegation Notes
- Power Fx Search() is delegable to Dataverse
- Filter() is delegable
- Combine for best performance:
  \\\
  Filter(
    kait_application,
    Search(SearchBox.Value, kait_applicationname)
  )
  \\\

### Error Handling

#### Safe Column Access
\\\powerfx
// Check if column exists before using
If(
  IsBlank(ThisRecord.kait_somecolumn),
  "N/A",
  ThisRecord.kait_somecolumn
)
\\\

#### Date Validation
\\\powerfx
// Ensure date fields are valid before calculations
If(
  And(
    Not(IsBlank(startDate)),
    Not(IsBlank(endDate)),
    startDate <= endDate
  ),
  Days(endDate, startDate),
  -1  // Invalid
)
\\\

---

**Last Updated**: September 2, 2026  
**Formula Complexity**: Intermediate  
**Dataverse Delegation**: Optimized  
