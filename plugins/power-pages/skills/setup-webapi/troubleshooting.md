# Troubleshooting Guide

This document covers common issues when setting up Power Pages Web API and their solutions.

## Quick Reference

| Issue | Solution |
|-------|----------|
| `403 Forbidden` | Table permission not configured, not linked to web role, or missing/expired CSRF token |
| `404 Not Found` | Web API not enabled for table (check site setting) |
| `400 Bad Request` | Invalid OData query syntax, missing `$select`, or field not in allowed list |
| `500 Server Error` | Enable `Webapi/error/innererror` to see details |
| `CSRF Token Error` | Ensure `__RequestVerificationToken` header is included for POST/PATCH/DELETE requests |
| `Field not allowed` | Add `$select` param with only fields listed in `Webapi/<table>/fields` setting |

## Site Settings Not Being Applied

### Symptoms

- Web API returns 404 even though settings exist
- Settings don't appear in Power Pages Studio

### Solutions

1. **Validate YAML syntax**

   ```yaml
   # Correct
   id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
   name: Webapi/cr_product/enabled
   value: true

   # Incorrect (missing quotes can cause issues in some cases)
   id: a1b2c3d4e5f6-7890-abcd-ef1234567890  # Invalid UUID format
   ```

2. **Verify file extension is `.yml`** (not `.yaml`)

3. **Check that `id` is a valid UUID**

   ```powershell
   # Generate a valid UUID
   [guid]::NewGuid().ToString()
   ```

4. **Re-upload the site after adding settings**

   ```powershell
   pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
   ```

## Web API Returns 403 Forbidden

### Symptoms

- GET requests return 403
- POST/PATCH/DELETE requests fail with 403

### For GET Requests

1. **Verify table permission exists**

   ```powershell
   # Check permissions in Dataverse
   $baseUrl = "<ENV_URL>/api/data/v9.2"
   Invoke-RestMethod -Uri "$baseUrl/adx_entitypermissions?`$filter=adx_entitylogicalname eq 'cr_product'" -Headers $headers
   ```

2. **Check permission is linked to correct web role**
   - For public access: Link to "Anonymous Users"
   - For authenticated access: Link to "Authenticated Users"

3. **Verify permission has Read enabled**

   ```powershell
   # Permission should have adx_read = true
   ```

4. **Verify permission scope**
   - Global (756150000) for public data
   - Self (756150004) for user-specific data

### For POST/PATCH/DELETE Requests

1. **Ensure CSRF token is included**

   ```javascript
   // Fetch token
   const response = await fetch('/_layout/tokenhtml');
   const html = await response.text();
   const match = html.match(/value="([^"]+)"/);
   const token = match ? match[1] : null;

   // Include in request
   fetch('/_api/cr_products', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       '__RequestVerificationToken': token
     },
     body: JSON.stringify(data)
   });
   ```

2. **Check if token expired**
   - Clear cached token and fetch a new one
   - Tokens can expire after extended inactivity

3. **Verify Create/Write/Delete permissions**
   - POST requires `adx_create = true`
   - PATCH requires `adx_write = true`
   - DELETE requires `adx_delete = true`

## CSRF Token Issues

### Test Token Fetch Manually

```javascript
// In browser console
fetch('/_layout/tokenhtml')
  .then(r => r.text())
  .then(html => {
    const match = html.match(/value="([^"]+)"/);
    console.log('Token:', match ? match[1] : 'Not found');
  });
```

### Common Token Problems

| Problem | Solution |
|---------|----------|
| Token not found | Ensure `/_layout/tokenhtml` is accessible |
| Token expired | Clear cache and fetch new token |
| Token not sent | Check header name is `__RequestVerificationToken` |
| Wrong token format | Parse HTML correctly to extract value |

## Web API Returns 404 Not Found

### Solutions

1. **Verify site setting exists and is enabled**

   ```yaml
   name: Webapi/cr_product/enabled
   value: true  # Must be boolean true, not string "true"
   ```

2. **Check entity set name is correct**
   - Use pluralized logical name
   - Example: `cr_product` table → `cr_products` entity set

3. **Ensure table exists in Dataverse**

   ```powershell
   # List tables
   pac table list
   ```

4. **Re-upload site settings**

   ```powershell
   pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
   ```

## Web API Returns 400 Bad Request

### Common Causes

1. **Invalid OData query syntax**

   ```text
   # Incorrect
   /_api/cr_products?filter=cr_isactive eq true

   # Correct ($ prefix required)
   /_api/cr_products?$filter=cr_isactive eq true
   ```

2. **Missing $select when fields are restricted** (Most Common)

   When `Webapi/<table>/fields` site setting specifies allowed fields, you **must** use `$select` in your query. Without `$select`, the API tries to return all fields and fails because only configured fields are allowed.

   ```text
   # Site setting
   name: Webapi/cr_product/fields
   value: cr_name,cr_price,cr_isactive

   # Incorrect (no $select - tries to fetch all fields)
   /_api/cr_products
   /_api/cr_products?$filter=cr_isactive eq true

   # Correct (only requests allowed fields)
   /_api/cr_products?$select=cr_name,cr_price,cr_isactive
   /_api/cr_products?$select=cr_name,cr_price,cr_isactive&$filter=cr_isactive eq true
   ```

   **Solution**: Always include `$select` with fields that match your `Webapi/<table>/fields` site setting:

   ```typescript
   // Always specify select with allowed fields
   webApi.getAll<Product>('cr_products', {
     select: ['cr_name', 'cr_price', 'cr_isactive'],
     filter: 'cr_isactive eq true',
   });
   ```

3. **Field not in allowed fields list**
   - Check `Webapi/<table>/fields` setting
   - Add missing fields to the comma-separated list

3. **Invalid filter value**

   ```text
   # Incorrect (string needs quotes)
   $filter=cr_category eq Electronics

   # Correct
   $filter=cr_category eq 'Electronics'
   ```

4. **Invalid data type in request body**

   ```javascript
   // Incorrect
   { "cr_price": "99.99" }  // String instead of number

   // Correct
   { "cr_price": 99.99 }
   ```

## Web API Returns 500 Server Error

### Enable Detailed Error Messages

1. **Create error setting**

   ```yaml
   # File: Webapi-error-innererror.sitesetting.yml
   id: <uuid>
   name: Webapi/error/innererror
   value: true
   ```

2. **Upload and test again**

   ```powershell
   pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
   ```

3. **Check browser Network tab for detailed error response**

### Common Server Errors

| Error Message | Solution |
|---------------|----------|
| "Entity not found" | Check table logical name |
| "Invalid field" | Field doesn't exist or not in allowed list |
| "Permission denied" | Check table permissions and web role |

## CORS Errors in Browser

Power Pages Web API should not have CORS issues when called from the same origin.

### If CORS Errors Occur

1. **Use relative URLs**

   ```javascript
   // Correct
   fetch('/_api/cr_products')

   // Incorrect (may cause CORS issues)
   fetch('https://site.powerappsportals.com/_api/cr_products')
   ```

2. **Check HTTP vs HTTPS**
   - Ensure site URL and API URL use same protocol

3. **Verify origin matches**
   - Request must come from same domain as the site

## Data Not Displaying

### Debugging Steps

1. **Check browser console for JavaScript errors**

2. **Verify API response in Network tab**
   - Look for the `/_api/...` request
   - Check response status and body

3. **Test API directly in browser**

   ```text
   https://<site-url>/_api/cr_products
   ```

4. **Check field name mapping**
   - Ensure frontend uses Dataverse column logical names
   - Example: `cr_productid` not `id`

5. **Verify data exists in Dataverse**

   ```powershell
   # Query via Dataverse API
   Invoke-RestMethod -Uri "$baseUrl/cr_products" -Headers $headers
   ```

## Debug Checklist

Use this checklist to systematically debug Web API issues:

- [ ] Site settings uploaded? (`pac pages upload-code-site`)
- [ ] Site setting syntax valid? (YAML format, boolean values)
- [ ] Table permission created? (check in Power Pages Studio)
- [ ] Permission linked to web role? (Anonymous Users for public)
- [ ] Permission has correct CRUD flags?
- [ ] CSRF token included for write operations?
- [ ] OData query syntax correct? (`$filter`, `$select`, etc.)
- [ ] **`$select` included with allowed fields?** (Required when `Webapi/<table>/fields` is set)
- [ ] Fields in allowed fields list?
- [ ] Entity set name correct? (pluralized)
- [ ] Data exists in Dataverse?
- [ ] Error details enabled for debugging?

## Verify in Power Pages Studio

### Check Site Settings

1. Go to Power Pages Studio
2. Navigate to **Setup > Site Settings**
3. Search for "Webapi"
4. Verify settings are present

### Check Table Permissions

1. Go to Power Pages Studio
2. Navigate to **Security > Table Permissions**
3. Verify permissions exist
4. Check they're linked to appropriate web roles

## Reference Documentation

- [Power Pages Web API Overview](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview)
- [Web API Operations](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations)
- [Site Settings Reference](https://learn.microsoft.com/en-us/power-pages/configure/configure-site-settings)
- [Table Permissions](https://learn.microsoft.com/en-us/power-pages/security/table-permissions)
- [OData Query Options](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-data-web-api)
