// ---------------- Type Definitions which can be imported from ./RuntimeTypes -------------------------
export interface TableRegistrations extends BaseTableRegistrations {
    "task": task,
}
export interface EnumRegistrations extends BaseEnumRegistrations {
    "task-isbilled": task_isbilled,
    "task-isregularactivity": task_isregularactivity,
    "task-isworkflowcreated": task_isworkflowcreated,
    "task-prioritycode": task_prioritycode,
    "task-statecode": task_statecode,
    "task-statuscode": task_statuscode,
}
export type task = TableRow<{
    // Primary Key Column
    readonly activityid: string,
    activityadditionalparams: string,
    readonly activitytypecode: string,
    actualdurationminutes: number,
    actualend: Date,
    actualstart: Date,
    category: string,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    readonly createdonbehalfbyname: string,
    readonly createdonbehalfbyyominame: string,
    crmtaskassigneduniqueid: string,
    description: string,
    readonly exchangerate: number,
    isbilled: task_isbilled,
    readonly isregularactivity: task_isregularactivity,
    isworkflowcreated: task_isworkflowcreated,
    lastonholdtime: Date,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    readonly modifiedonbehalfbyname: string,
    readonly modifiedonbehalfbyyominame: string,
    readonly onholdtime: number,
    readonly owningbusinessunitname: string,
    percentcomplete: number,
    prioritycode: task_prioritycode,
    processid: string,
    // Foreign Key Column
    readonly _regardingobjectid_value: `/account(${string})` | `/adx_invitation(${string})` | `/bookableresourcebooking(${string})` | `/bookableresourcebookingheader(${string})` | `/bulkoperation(${string})` | `/campaign(${string})` | `/campaignactivity(${string})` | `/contact(${string})` | `/contract(${string})` | `/entitlement(${string})` | `/entitlementtemplate(${string})` | `/incident(${string})` | `/invoice(${string})` | `/knowledgearticle(${string})` | `/knowledgebaserecord(${string})` | `/lead(${string})` | `/msdyn_customerasset(${string})` | `/msdyn_playbookinstance(${string})` | `/msdyn_postalbum(${string})` | `/msdyn_salessuggestion(${string})` | `/msdyn_swarm(${string})` | `/mspp_adplacement(${string})` | `/mspp_pollplacement(${string})` | `/mspp_publishingstatetransitionrule(${string})` | `/mspp_redirect(${string})` | `/mspp_shortcut(${string})` | `/mspp_website(${string})` | `/opportunity(${string})` | `/quote(${string})` | `/salesorder(${string})` | `/site(${string})`,
    readonly regardingobjectidname: string,
    readonly regardingobjectidyominame: string,
    regardingobjecttypecode: string,
    readonly scheduleddurationminutes: number,
    scheduledend: Date,
    scheduledstart: Date,
    // Foreign Key Column
    readonly _serviceid_value: `/service(${string})`,
    readonly serviceidname: string,
    // Foreign Key Column
    readonly _slaid_value: `/sla(${string})`,
    // Foreign Key Column
    readonly _slainvokedid_value: `/sla(${string})`,
    readonly slainvokedidname: string,
    readonly slaname: string,
    sortdate: Date,
    stageid: string,
    statecode: task_statecode,
    statuscode: task_statuscode,
    subcategory: string,
    subject: string,
    readonly subscriptionid: string,
    // Foreign Key Column
    readonly _transactioncurrencyid_value: `/transactioncurrency(${string})`,
    readonly transactioncurrencyidname: string,
    traversedpath: string,
}>

const enum task_isbilled {
"No" = 0,
"Yes" = 1,
}
const enum task_isregularactivity {
"No" = 0,
"Yes" = 1,
}
const enum task_isworkflowcreated {
"No" = 0,
"Yes" = 1,
}
const enum task_prioritycode {
"Low" = 0,
"Normal" = 1,
"High" = 2,
}
const enum task_statecode {
"Open" = 0,
"Completed" = 1,
"Canceled" = 2,
}
const enum task_statuscode {
"Not Started" = 2,
"In Progress" = 3,
"Waiting on someone else" = 4,
"Completed" = 5,
"Canceled" = 6,
"Deferred" = 7,
}

export interface UxAgentDataApi extends BaseUxAgentDataApi<TableRegistrations, EnumRegistrations> {}

export interface GeneratedComponentProps {
    dataApi: UxAgentDataApi;
}

