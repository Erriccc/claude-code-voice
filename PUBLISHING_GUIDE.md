# Claude Code Voice - Publishing Guide

Complete documentation of the publishing process for VS Code extensions.

---

## Overview

This extension was published to multiple platforms:

| Platform | URL | Status |
|----------|-----|--------|
| **GitHub Repository** | https://github.com/Erriccc/claude-code-voice | ✅ Live |
| **GitHub Releases** | https://github.com/Erriccc/claude-code-voice/releases | ✅ v1.0.0 |
| **VS Code Marketplace** | https://marketplace.visualstudio.com/items?itemName=Fultonmarketaistudio.claude-code-voice | ✅ Published |

---

## Publishing Options Explained

### Option 1: GitHub Releases (Easiest - No accounts needed)

**What it is:** Upload the `.vsix` file to GitHub Releases for manual download.

**Pros:**
- No additional accounts required
- Immediate availability
- Full control

**Cons:**
- Users must manually download and install
- Not searchable in VS Code marketplace

**How users install:**
```bash
# Download .vsix from releases page, then:
code --install-extension claude-code-voice-1.0.0.vsix
```

---

### Option 2: VS Code Marketplace (What we used)

**What it is:** Microsoft's official extension marketplace, integrated into VS Code.

**Pros:**
- Searchable directly in VS Code
- One-click install for users
- Most visibility

**Cons:**
- Requires Microsoft account
- Requires Azure DevOps PAT token
- Review process can take time

**Accounts Required:**
1. **Microsoft Account** - Free, any email works
2. **Azure DevOps Account** - Linked to Microsoft account (auto-created)
3. **VS Code Marketplace Publisher** - Created at marketplace.visualstudio.com

---

### Option 3: Open VSX (GitHub login)

**What it is:** Open-source alternative marketplace (Eclipse Foundation).

**Pros:**
- Uses GitHub login (no Microsoft account)
- Works with VSCodium, Gitpod, Eclipse Theia

**Cons:**
- NOT visible in standard VS Code (only alternatives)
- Requires signing Eclipse Publisher Agreement
- Smaller user base

**Not recommended** unless targeting VSCodium users specifically.

---

## Step-by-Step: What We Did

### Step 1: Prepared the Extension

1. Updated `package.json` with publisher info:
   ```json
   {
     "name": "claude-code-voice",
     "displayName": "Claude Code Voice",
     "publisher": "Fultonmarketaistudio",
     "version": "1.0.0"
   }
   ```

2. Created `.gitignore` to exclude:
   - `node_modules/`
   - `out/`
   - `*.vsix`
   - `.claude/`

3. Compiled TypeScript:
   ```bash
   npm run compile
   ```

4. Packaged extension:
   ```bash
   npx vsce package
   # Creates: claude-code-voice-1.0.0.vsix
   ```

---

### Step 2: GitHub Repository

1. Initialized fresh git repo (cleared old history):
   ```bash
   rm -rf .git
   git init
   git branch -m main
   ```

2. Created initial commit:
   ```bash
   git add .
   git commit -m "Initial commit: Claude Code Voice Extension"
   ```

3. Created GitHub repo and pushed:
   ```bash
   gh repo create claude-code-voice --public --source=. --push
   ```

**Result:** https://github.com/Erriccc/claude-code-voice

---

### Step 3: GitHub Release

Created release with `.vsix` attached:
```bash
gh release create v1.0.0 claude-code-voice-1.0.0.vsix \
  --title "v1.0.0 - Initial Release" \
  --notes "Release notes here..."
```

**Result:** https://github.com/Erriccc/claude-code-voice/releases/tag/v1.0.0

---

### Step 4: VS Code Marketplace Publisher Account

1. **Created Microsoft Account**
   - URL: https://account.microsoft.com/account
   - Email used: ozyjunks@gmail.com

2. **Created Publisher**
   - URL: https://marketplace.visualstudio.com/manage
   - Signed in with Microsoft account
   - Clicked "Create Publisher"
   - Publisher details:
     - **Name:** Fulton market ai studio
     - **ID:** Fultonmarketaistudio (this goes in package.json)

---

### Step 5: Azure DevOps Personal Access Token (PAT)

**Why needed:** VS Code Marketplace uses Azure DevOps for authentication.

1. Went to: https://aex.dev.azure.com/me (or https://dev.azure.com/_usersSettings/tokens)
2. Signed in with same Microsoft account
3. Created new Personal Access Token:
   - **Name:** vsce
   - **Organization:** All accessible organizations
   - **Expiration:** 90 days
   - **Scopes:** Marketplace > Manage (must click "Show all scopes" to find it)
4. Copied the generated token (only shown once!)

---

### Step 6: Published to Marketplace

```bash
npx vsce publish -p YOUR_PAT_TOKEN_HERE
```

**Output:**
```
INFO  Publishing 'Fultonmarketaistudio.claude-code-voice v1.0.0'...
INFO  Extension URL: https://marketplace.visualstudio.com/items?itemName=Fultonmarketaistudio.claude-code-voice
DONE  Published Fultonmarketaistudio.claude-code-voice v1.0.0.
```

---

## Account Summary

| Service | URL | Account |
|---------|-----|---------|
| GitHub | github.com | Erriccc |
| Microsoft | account.microsoft.com | ozyjunks@gmail.com |
| Azure DevOps | dev.azure.com | (linked to Microsoft) |
| VS Marketplace | marketplace.visualstudio.com | Publisher: Fultonmarketaistudio |

---

## Troubleshooting

### Extension shows 404

- **Wait 5-15 minutes** - Marketplace indexing takes time
- Check status: `npx vsce show Fultonmarketaistudio.claude-code-voice`
- Check publisher dashboard: https://marketplace.visualstudio.com/manage/publishers/Fultonmarketaistudio

### PAT Token Issues

- Token must have **Marketplace > Manage** scope
- Organization must be **All accessible organizations**
- Token expires - create new one if expired

### Publishing Fails

- Ensure `publisher` in package.json matches your publisher ID exactly
- Run `npm run compile` before packaging
- Check for errors: `npx vsce package`

---

## Future Updates

To publish a new version:

1. Update version in `package.json`:
   ```json
   "version": "1.1.0"
   ```

2. Commit and push:
   ```bash
   git add .
   git commit -m "v1.1.0 - New features"
   git push
   ```

3. Publish:
   ```bash
   npx vsce publish -p YOUR_PAT_TOKEN
   ```

4. Create GitHub release:
   ```bash
   npx vsce package
   gh release create v1.1.0 claude-code-voice-1.1.0.vsix
   ```

---

## Files Reference

| File | Purpose |
|------|---------|
| `package.json` | Extension manifest (name, publisher, version) |
| `.vscodeignore` | Files to exclude from .vsix package |
| `.gitignore` | Files to exclude from git |
| `VOICE_PRD.md` | Product requirements / architecture |
| `README.md` | User-facing documentation |
| `CHANGELOG.md` | Version history |

---

## Useful Commands

```bash
# Package extension
npx vsce package

# Check extension info
npx vsce show Fultonmarketaistudio.claude-code-voice

# Publish new version
npx vsce publish -p YOUR_TOKEN

# Login (saves token)
npx vsce login Fultonmarketaistudio

# Install locally for testing
code --install-extension claude-code-voice-1.0.0.vsix
```
