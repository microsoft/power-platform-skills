# Star rating plan

## Summary

- **Control:** Contoso.Controls.StarRating
- **Description:** Shows a whole number as 0-5 stars
- **Template:** field-standard
- **Recipe:** none
- **Connectivity:** online

## Hosts

- Power Pages

## Properties

| Name | Usage | Type | Required | Default |
| --- | --- | --- | --- | --- |
| value | bound | Whole.None | yes |  |
| max | input | Whole.None | no | 5 |

## Bindings

| # | Kind | Table | Form | Target | Web | Phone | Tablet | Parameters |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _No intended bindings._ |  |  |  |  |  |  |  |  |

## Deploy target

- **Solution:** ContosoCore
- **Publisher prefix:** use solution publisher
- **Environment:** https://contoso.crm.dynamics.com
- **Registration:** `pac pcf push --environment <environment>` after skill-level consent.

## Power Pages steps

- Standalone Liquid: add `{% codecomponent name:<registered control name> <property>:'<value>' %}` to the page source with explicit property values; save, select **Sync**, then **Preview**, and confirm the control renders.

## Findings

- No blocking or advisory findings.

## What will be verified

- The manifest properties match the intended parameters.
- Each intended binding is present for every requested client.
- Draft and published form XML agree after publication.
- Power Pages journeys are manually configured where automation is not available.
