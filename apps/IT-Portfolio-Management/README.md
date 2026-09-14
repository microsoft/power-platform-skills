# IT Portfolio Management Canvas Application
## Kraus-Anderson Enterprise Solution

### Overview
A comprehensive Canvas application for managing IT application portfolios, vendor relationships, contracts, budgets, and cost allocations across Kraus-Anderson's enterprise.

### Quick Start

#### Prerequisites
- Power Apps license (Premium or higher recommended)
- Access to the itportfoliomgmt-dev Dataverse environment
- Modern browser (Chrome, Edge, Safari)

#### Environment Details
- **Dataverse Environment**: https://itportfoliomgmt-dev.crm.dynamics.com
- **Tables Used**: 10 core tables (see architecture documentation)

### Application Architecture

#### 10 Primary Screens

| Screen | Purpose | Key Features |
|--------|---------|--------------|
| Home Dashboard | Executive overview and quick access | KPI cards, renewal alerts, quick navigation |
| Application Portfolio | Application inventory management | Search, multi-filter, master-detail gallery |
| Vendor Management | Vendor directory and relationships | Vendor search, contact info, contract tracking |
| Contract Management | Contract lifecycle and renewals | Advanced filtering, status tracking, document links |
| Contract Document Viewer | PDF document management | Document metadata, embedded viewer, download |
| Renewal Dashboard | 90-day renewal focus and alerts | Critical alerts, expiration tracking, summary |
| Budget Analysis | Budget vs actual comparison | Year/department filters, variance analysis |
| Cost Allocation | Department cost breakdown | Allocation method tracking, pie charts |
| Application Detail | Deep dive on single application | Lifecycle info, contracts, allocations |
| Settings | Administration and configuration | (Future: notification preferences, etc.) |

### Data Model

#### Core Tables

1. **kait_application**
   - Application inventory with status, category, type
   - Business owner and department tracking
   - Criticality and lifecycle status

2. **kait_vendor**
   - Vendor master data
   - Contact information
   - Industry and region details

3. **kait_contract**
   - Software agreements and subscriptions
   - Dates: start, end, renewal
   - Amount, terms, auto-renewal flag
   - Links to vendor, applications, departments

4. **kait_contractdocument**
   - PDF and supporting documents
   - Metadata: type, upload date, version
   - File URI for viewing/download

5. **kait_budgethistory**
   - Annual budget tracking by application/department
   - Budget vs actual amounts
   - Variance calculations (amount and %)

6. **kait_department**
   - Department master data
   - Parent entity relationship

7. **kait_entity**
   - Business entities (Construction, Realty, etc.)
   - Parent to departments

8. **kait_notificationgroup**
   - Renewal notification recipients
   - Links to contracts

9. **kait_applicationallocation**
   - Application cost by department
   - Allocation method (user count, license count, manual %)
   - Year-based tracking

10. **kait_applicationallocationsummary**
    - Pre-calculated allocation summaries
    - Department-level aggregations

### Key Features & Capabilities

#### 1. Application Portfolio Management
- **Inventory Tracking**: Maintain complete software application catalog
- **Status Management**: Active, Planned, Retired, Under Review
- **Advanced Filtering**: By status, department, category, criticality
- **Quick Search**: Application name, vendor, category search
- **Detailed Forms**: Complete application lifecycle information

#### 2. Vendor Management
- **Vendor Directory**: Searchable vendor master
- **Relationship Tracking**: Associated applications and contracts
- **Contact Management**: Email and phone information
- **Performance Metrics**: Contract count and spend

#### 3. Contract Management
- **Contract Lifecycle**: Track all software agreements
- **Renewal Tracking**: Automated renewal date calculations
- **Status Indicators**: Active, Expired, Renewal Pending
- **Multi-Filter Search**: By vendor, type, department, status
- **Document Attachment**: Links to PDFs and supporting docs

#### 4. Renewal Notifications
- **90-Day Dashboard**: Upcoming renewals at a glance
- **Alert System**: 14-day critical alerts prominently displayed
- **Status Badges**: Visual urgency indicators
  - Red: Urgent (<14 days)
  - Orange: Soon (14-30 days)
  - Yellow: Upcoming (30-90 days)
  - Green: On Track (>90 days)
- **Notification Groups**: Stakeholder assignments for alerts

#### 5. Budget Management
- **Year-Based Tracking**: Multi-year budget history
- **Variance Analysis**: Amount and percentage variance
- **Department Rollup**: Budget by department and application
- **Visual Comparison**: Column chart of budget vs actual

#### 6. Cost Allocation
- **Multi-Method Support**:
  - User count-based allocation
  - License count allocation
  - Manual percentage allocation
- **Department Attribution**: Apply costs across consuming departments
- **Year-Over-Year**: Historical allocation tracking
- **Pie Chart Visualization**: Department cost breakdown

#### 7. Document Management
- **PDF Viewing**: Embedded contract document viewer
- **Metadata Display**: Document type, upload date, version
- **Download Option**: Export contracts for offline access
- **Version History**: Track document changes over time

#### 8. Executive Dashboards
- **KPI Cards**: Total applications, contracts, vendors, annual spend
- **Expiration Alerts**: 30-day expiration warning
- **Status Charts**: Renewal status by month
- **Department Allocation Pie**: Visual cost distribution

### User Roles & Access

#### Recommended Role-Based Personas

1. **Executive Dashboard User**
   - Home dashboard focus
   - Read-only access to renewals
   - Budget and spend reporting

2. **IT Portfolio Manager**
   - Full access to all screens
   - Create/edit applications and contracts
   - Manage renewal workflow

3. **Financial Analyst**
   - Budget and cost allocation focus
   - Department-level spending reports
   - Read-only to contracts

4. **Department Manager**
   - View applications used by department
   - See allocated costs
   - Read-only to contracts

5. **Vendor Manager**
   - Vendor directory management
   - Contract relationship tracking
   - Renewal notifications

### Color Scheme & UX Principles

#### Status Colors
- **Green**: Active, On Track
- **Yellow**: Upcoming renewals (30-90 days)
- **Orange**: Soon renewals (14-30 days)
- **Red**: Urgent/Expired (<14 days)

#### Design Principles
- Clean, executive-friendly interface
- Data-forward presentation
- Consistent navigation
- Mobile-responsive where possible
- Accessible (WCAG 2.1 AA compliance target)

### Workflow: Contract Renewal Process

`
1. Daily: Renewal dashboard checks for expiring contracts
2. 90 Days Out: Contracts appear on Renewal Dashboard
3. 60 Days Out: Email notifications sent (via Power Automate)
4. 30 Days Out: Marked "Soon" - orange badge
5. 14 Days Out: Marked "Urgent" - red badge, critical alert
6. Contract Detail: View all terms, documents, linked apps
7. Renewal: Mark status as "Renewal Pending"
8. Post-Renewal: Update end date, clear alert
`

### Deployment Instructions

#### Method 1: Power Apps Studio (Recommended for Development)
1. Navigate to https://make.powerapps.com
2. Select environment: itportfoliomgmt-dev
3. Click "Create" → "Blank app" → "Create"
4. Import the Canvas app YAML file
5. Connect to Dataverse tables
6. Test all screens and galleries
7. Publish to users

#### Method 2: Solution Import (for Production)
1. Create or add to a Power Platform Solution
2. Add the Canvas app component
3. Import the solution to target environment
4. Verify all data connections
5. Assign to security roles
6. Monitor telemetry and usage

### Performance Considerations

- **Gallery Optimization**: Use paging for large datasets (>500 rows)
- **Search Performance**: Implement server-side filtering when possible
- **Document Viewer**: Lazy-load PDFs to avoid delays
- **Refresh Strategy**: Balance real-time vs. periodic updates
- **Cache Management**: Use Power Fx variables for frequently accessed data

### Future Enhancements

- [ ] Power Automate integration for renewal notifications
- [ ] Email alerts 180, 90, 60, 30, 14, 7 days before renewal
- [ ] Approval workflow for contract renewals
- [ ] Mobile app responsive design
- [ ] Advanced reporting in Power BI
- [ ] Vendor scorecards
- [ ] Contract compliance dashboard
- [ ] Integration with ticketing systems
- [ ] AI-powered spend analysis

### Troubleshooting

#### Common Issues

**Gallery not loading data**
- Verify Dataverse connection is active
- Check table permissions
- Confirm filter formula syntax
- Clear browser cache

**PDF Viewer not displaying**
- Verify document URI is valid
- Check file permissions
- Ensure PDF format supported
- Try PDF download instead

**Search not finding records**
- Verify search fields are indexed
- Check filter criteria
- Clear varSearchText variable
- Confirm data exists

**Dropdown filters not populated**
- Verify data source table connection
- Check for null/blank records
- Confirm displayField exists
- Refresh data source

### Support & Documentation

For issues or enhancements:
- Review specification document: SPECIFICATION.md
- Check architecture: CanvasApp-Architecture.yaml
- Contact: IT Portfolio Management Team

### Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-09-02 | Initial release |

---

**Created**: September 2, 2026  
**Environment**: itportfoliomgmt-dev.crm.dynamics.com  
**Publisher**: Kraus-Anderson IT  
