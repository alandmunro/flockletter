# Companies and sending brands

A current Clerk workspace owner can manage business entities in **Workspace → Companies & brands**. A new workspace starts with one company named for the workspace, and its first brand belongs to that company. Preparation access allows one company and one brand. Starter, Growth and Pro use the shared plan catalogue's company and brand totals of 1/1, 3/3 and 5/5.

Select **Add company** to create another entity within the applicable limit. Expand a company's controls to rename it or add a brand. Expand a brand to rename it or move it to another company in this workspace. Moving a brand preserves its identity, subscribers, sender, assets, drafts and explicit connection grants. Counts apply to the entire workspace. A reduction in plan limits retains every existing record and prevents further creation above the remaining allowance.

Company names must be distinct among companies and brand names among brands in the workspace. Matching trims outer whitespace and ignores case. An existing business and its brand may share a name. The migration preserves historical duplicate brand names and their separate identities. An owner can rename those records individually.

## Migration and verification

Migration 006 creates one deterministic default company for each existing workspace and associates its original brands in the same transaction. Future workspace and brand inserts receive their associations through insert triggers, including inserts from compatible earlier web revisions. Reapplying the migration preserves renamed companies and deliberate brand moves. The runtime has only the required operations on the two workspace-scoped tables. Membership references include workspace identity in both foreign keys.

`tests/companies.test.ts` exercises a non-superuser legacy migration and repeat application, concurrent creation at a shared limit, retries, forbidden remote parent IDs, data retained on downgrade, normalized name conflicts and workspace-owner requirements. `npm run audience:verify` includes normal browser interaction with the company and brand controls using a disposable workspace.

This work covers the company and brand parts of FL-USG-006 and FL-AT-034. Team invitations and membership limits have separate requirements.
