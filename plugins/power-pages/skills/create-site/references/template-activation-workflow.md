# Template activation

Enter only after the site-provisioning and seed-data workstreams have joined and their results are recorded.

15. Mark **Activate template site** as `in_progress`. Before invoking `/activate-site`, update the status page:
       ```json
       { "state": "running", "phase": "activation", "message": "Activating template site", "awaitingInput": false }
       ```
       Then invoke `/activate-site`, passing the resolved identity and status path in the request so it skips local-project discovery and can show a toast while waiting for activation input:
       ```text
       Activate cloned template site:
       - siteName: <IMPORTED_SITE_NAME>
       - websiteRecordId: <IMPORTED_WEBSITE_RECORD_ID>
       - environmentUrl: <environmentUrl>
       - statusPath: <temp-import-status-dir>/status.json
       - source: create-site template path
       ```
       The activate-site skill owns subdomain selection, the waiting-for-input toast, final activation confirmation, provisioning-status polling, and recovery. Its foreground activation script is the only poll required by this flow.
       If activation fails, tell the user the cloned site exists but is not live and can be activated later by rerunning `/activate-site` with this identity. Do not treat activation failure as a failed supporting-solution import or site upload.
   16. When `/activate-site` returns a `siteUrl`, mark **Activate template site** as `completed` and **Show live template site** as `in_progress`.
   17. Complete the already-open status page without redirecting it:
       ```json
       {
         "state": "succeeded",
         "message": "Template site is live.",
         "siteUrl": "<siteUrl>"
       }
       ```
       The shared provisioning page shows an **Open website** button, matching the non-SPA
       workflow. Do not redirect the status tab or open the live site automatically. If the user
       closed the status page, show the `siteUrl` for manual opening.

       Always surface the activate-site DNS propagation caveat: the site may take a few minutes to
       load even after activation succeeds. Do not start a separate background command or worker to
       wait for the live URL to return HTTP 200.
   18. Mark **Show live template site** as `completed`, then present the template-path summary:
       - Template name and framework
       - Cloned site name and Website Record ID
       - Live site URL
       - DNS propagation note: the site may take a few minutes to load everywhere
       - Local project path (`PROJECT_ROOT`)
       - "Your site is live. Want to keep customizing the local project?"

<!-- not-a-gate: optional post-live template customization branch; the local clone already exists and the site is live -->

   19. Offer optional customization.

       Ask the user:

       | Question | Header | Options |
       |----------|--------|---------|
       | Your template site is live. Do you want to customize the local project now? | Customize Template Site | Yes, customize now (Recommended), No, finish here |

       - **No, finish here**: mark **Select template or choose from-scratch** as `completed`, then stop.
       - **Yes, customize now**: append the template customization tasks (see the entry-linked progress-tracking contract), then continue below.
