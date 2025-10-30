# Deployment Guide

This document outlines the production deployment strategy for the Solana LST Vault application.

## Table of Contents
- [Current Setup (Development)](#current-setup-development)
- [Production Deployment (Future)](#production-deployment-future)
- [Sanctum API Overview](#sanctum-api-overview)
- [Nginx Proxy Configuration](#nginx-proxy-configuration)
- [Ansible Deployment](#ansible-deployment)
- [Cost Analysis](#cost-analysis)

---

## Current Setup (Development)

The application currently uses Sanctum's Ironforge API with environment variables for local development.

### Environment Variables

```bash
# web/.env.local (gitignored)
VITE_SANCTUM_API_KEY=your_ironforge_api_key_here
```

### Running Locally

```bash
cd web
npm install
npm run dev
```

The app will call Sanctum API directly from the browser with the API key in the request.

**Security Note**: This is acceptable for development but NOT for production, as the API key would be exposed in browser JavaScript.

---

## Production Deployment (Future)

For production, we'll deploy with an nginx reverse proxy that injects the API key server-side, keeping it secure.

### Architecture

```
User Browser → nginx (SSL + API key injection) → Vite Static Files
                  ↓
            Sanctum API (with API key)
```

### Key Benefits

1. **Security**: API key never exposed to client-side JavaScript
2. **Caching**: nginx caches API responses (5-min TTL)
3. **Rate Limiting**: nginx can enforce rate limits per IP
4. **SSL/TLS**: Automatic Let's Encrypt certificates
5. **Monitoring**: Access logs, error logs, metrics

---

## Sanctum API Overview

### Service Information

- **Provider**: Ironforge (acquired by Sanctum)
- **API Base URL**: `https://sanctum-api.ironforge.network`
- **Documentation**: https://learn.sanctum.so/docs/for-developers/sanctum-api
- **Sign Up**: https://www.ironforge.sanctum.so/sign-in

### Authentication

All endpoints require an `apiKey` query parameter:
```
GET https://sanctum-api.ironforge.network/lsts/{mint}/apys?apiKey=YOUR_KEY
```

### Pricing Tiers (Ironforge)

| Tier     | Price/Month | Requests/Month | Overage      |
|----------|-------------|----------------|--------------|
| Free     | $0          | 100,000        | N/A          |
| Hobby    | $49         | 1,000,000      | $3/million   |
| Scale    | $249        | 250,000,000    | $3/million   |
| Business | $999        | 750,000,000    | $3/million   |

### Usage Estimate

With 5-minute caching and 2 LSTs:
- **Requests per hour**: 12 × 2 = 24
- **Requests per month**: ~17,000
- **Cost**: **FREE** (well under 100k limit)

Even with moderate traffic, the free tier is sufficient.

### Key Endpoints

#### Get LST Metadata
```
GET /lsts/{mintAddress}
```

Response:
```json
{
  "mint": "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  "symbol": "bSOL",
  "name": "BlazeStake Staked SOL",
  "logoURI": "https://...",
  "apy": 7.23,
  "tvl": 12345678.90
}
```

#### Get LST APY History
```
GET /lsts/{mintAddress}/apys?limit=10
```

Response:
```json
[
  {
    "epoch": 650,
    "epochEndTimestamp": 1730000000,
    "apy": 7.23
  },
  {
    "epoch": 649,
    "epochEndTimestamp": 1729900000,
    "apy": 7.18
  }
]
```

---

## Nginx Proxy Configuration

### Overview

nginx sits between the user's browser and both the static files (Vite build) and the Sanctum API. It:
1. Serves the Vite-built static files
2. Proxies `/api/sanctum/*` requests to Sanctum API
3. Injects the API key as a query parameter
4. Handles SSL/TLS termination
5. Caches API responses

### nginx Configuration

**File: `/etc/nginx/sites-available/solana-vault`**

```nginx
# HTTP -> HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name vault.yourdomain.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name vault.yourdomain.com;

    # SSL configuration
    ssl_certificate /etc/letsencrypt/live/vault.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vault.yourdomain.com/privkey.pem;
    ssl_dhparam /etc/ssl/dhparam.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Serve static files
    root /opt/solana-vault/web/dist;
    index index.html;

    # API proxy with injected API key
    location /api/sanctum/ {
        # Rewrite to remove /api/sanctum prefix
        rewrite ^/api/sanctum/(.*)$ /$1 break;

        # Proxy to Sanctum API
        proxy_pass https://sanctum-api.ironforge.network;

        # CRITICAL: Inject API key as query parameter
        set $args "${args}&apiKey=YOUR_API_KEY_HERE";

        # Headers
        proxy_set_header Host sanctum-api.ironforge.network;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Caching (5 minutes)
        proxy_cache sanctum_cache;
        proxy_cache_valid 200 5m;
        proxy_cache_bypass $http_cache_control;
        add_header X-Cache-Status $upstream_cache_status;

        # Timeouts
        proxy_connect_timeout 10s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }

    # SPA fallback - serve index.html for all routes
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### Cache Configuration

**File: `/etc/nginx/nginx.conf`** (add to http block)

```nginx
http {
    # ... existing config ...

    # Proxy cache path for Sanctum API
    proxy_cache_path /var/cache/nginx/sanctum
                     levels=1:2
                     keys_zone=sanctum_cache:10m
                     max_size=100m
                     inactive=60m
                     use_temp_path=off;

    # ... rest of config ...
}
```

### Manual Setup (Without Ansible)

```bash
# Install nginx and certbot
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx

# Create cache directory
sudo mkdir -p /var/cache/nginx/sanctum
sudo chown www-data:www-data /var/cache/nginx/sanctum

# Generate DH parameters (takes ~5 minutes)
sudo openssl dhparam -out /etc/ssl/dhparam.pem 2048

# Obtain SSL certificate
sudo certbot certonly --nginx -d vault.yourdomain.com

# Copy nginx config
sudo nano /etc/nginx/sites-available/solana-vault
# Paste the config above and replace YOUR_API_KEY_HERE

# Enable site
sudo ln -s /etc/nginx/sites-available/solana-vault /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### Frontend Configuration

For production, the frontend should use the nginx proxy instead of calling Sanctum API directly.

**File: `web/.env.production`**
```bash
VITE_SANCTUM_API_BASE=/api/sanctum
```

**File: `web/src/lib/sanctum-api.ts`**
```typescript
const SANCTUM_BASE_URL = import.meta.env.VITE_SANCTUM_API_BASE
  || 'https://sanctum-api.ironforge.network';
```

In production, all API calls go to `/api/sanctum/*` which nginx proxies to Sanctum.

---

## Ansible Deployment

For automated infrastructure-as-code deployment, we'll use Ansible following the patterns from `cosmos-ansible`.

### Repository Structure

```
sol-token-vault/
├── ansible/
│   ├── ansible.cfg
│   ├── requirements.yml
│   ├── deploy-frontend.yml
│   ├── provision-digitalocean.yml
│   ├── inventory/
│   │   ├── production.yml
│   │   └── staging.yml
│   └── roles/
│       └── solana-vault-frontend/
│           ├── defaults/main.yml
│           ├── tasks/
│           │   ├── main.yml
│           │   ├── dependencies.yml
│           │   ├── build.yml
│           │   └── nginx.yml
│           ├── templates/
│           │   └── nginx-site.j2
│           └── handlers/main.yml
└── ...

../sol-token-vault-private/  # Separate private repo
└── vault.yml                # Encrypted secrets
```

### Ansible Vault Setup

**1. Create Private Repository**

```bash
cd ..
mkdir sol-token-vault-private
cd sol-token-vault-private
git init
```

**2. Create Vault File**

```bash
# Create and encrypt vault
ansible-vault create vault.yml
# Enter password when prompted
```

**File: `../sol-token-vault-private/vault.yml`**
```yaml
---
vault_sanctum_api_key: "your-ironforge-api-key-here"
vault_digitalocean_api_key: "your-do-api-key-here"
vault_letsencrypt_email: "admin@yourdomain.com"
```

**3. Commit Encrypted Vault**

```bash
git add vault.yml
git commit -m "Add encrypted vault"
git remote add origin git@github.com:yourorg/sol-token-vault-private.git
git push -u origin main
```

### Inventory Configuration

**File: `ansible/inventory/production.yml`**

```yaml
---
all:
  vars:
    ansible_user: root
    ansible_python_interpreter: /usr/bin/python3

    # Application settings
    app_name: solana-lst-vault
    app_repo: https://github.com/yourorg/sol-token-vault.git
    app_version: main
    app_build_dir: /opt/solana-vault
    app_domain: vault.yourdomain.com

    # Sanctum API (from vault)
    sanctum_api_key: "{{ vault_sanctum_api_key }}"
    letsencrypt_email: "{{ vault_letsencrypt_email }}"

    # Node.js
    node_version: "20"

  children:
    frontend:
      hosts:
        "{{ target }}":
          # DigitalOcean provisioning
          digitalocean_hostname: solana-vault-prod
          digitalocean_size: s-2vcpu-2gb
          digitalocean_region: sfo3
          digitalocean_image: debian-12-x64
```

### Main Playbook

**File: `ansible/deploy-frontend.yml`**

```yaml
---
- name: Deploy Solana LST Vault Frontend
  hosts: frontend
  become: true

  vars_files:
    - ../../sol-token-vault-private/vault.yml

  roles:
    - role: geerlingguy.nodejs
    - role: solana-vault-frontend
```

### Role Implementation

See the nginx configuration section above for the complete role implementation.

### Deployment Commands

**Initial Setup:**

```bash
# Install Ansible dependencies
cd ansible
ansible-galaxy install -r requirements.yml

# Provision DigitalOcean droplet
ansible-playbook provision-digitalocean.yml \
  -i inventory/production.yml \
  -e target=localhost \
  --vault-password-file ~/.vault_pass.txt

# Deploy application
ansible-playbook deploy-frontend.yml \
  -i inventory/production.yml \
  -e target=YOUR_DROPLET_IP \
  --vault-password-file ~/.vault_pass.txt
```

**Updates:**

```bash
# Deploy new version
ansible-playbook deploy-frontend.yml \
  -i inventory/production.yml \
  -e target=vault.yourdomain.com \
  -e app_version=v1.2.0 \
  --vault-password-file ~/.vault_pass.txt
```

---

## Cost Analysis

### Infrastructure Costs

**DigitalOcean Droplet:**
- **Size**: s-2vcpu-2gb (2 vCPUs, 2GB RAM, 60GB SSD)
- **Cost**: $18/month
- **Bandwidth**: 3TB included

**Alternative (smaller):**
- **Size**: s-1vcpu-1gb (1 vCPU, 1GB RAM, 25GB SSD)
- **Cost**: $6/month
- **Sufficient for**: Low-medium traffic MVP

**Sanctum API:**
- **Tier**: Free
- **Requests**: 100,000/month
- **Cost**: $0/month
- **Estimated usage**: ~17,000/month with caching

**SSL Certificate:**
- **Provider**: Let's Encrypt
- **Cost**: $0/month

**Domain Name:**
- **Provider**: Namecheap, Google Domains, etc.
- **Cost**: ~$12/year

### Total Monthly Cost

| Component | Cost/Month |
|-----------|------------|
| DigitalOcean Droplet (2GB) | $18 |
| Sanctum API (Free tier) | $0 |
| SSL Certificate | $0 |
| **Total** | **$18/month** |

**Budget option**: $6/month with s-1vcpu-1gb droplet

### Scaling Considerations

With nginx caching (5-min TTL) and 2 LSTs:
- **10 users**: 170,000 requests/month → Free tier OK
- **100 users**: 1,700,000 requests/month → Hobby tier ($49/month)
- **1,000 users**: 17,000,000 requests/month → Hobby tier ($49/month)

The free tier is sufficient for MVP and moderate growth.

---

## Security Checklist

### Development
- [x] API key in `.env.local` (gitignored)
- [x] Never commit API keys to git
- [x] Use `.env.example` as template

### Production
- [ ] API key stored in Ansible vault (encrypted)
- [ ] API key injected by nginx server-side
- [ ] API key never exposed to client-side JavaScript
- [ ] SSL/TLS enabled with Let's Encrypt
- [ ] Security headers configured (HSTS, X-Frame-Options, etc.)
- [ ] DH parameters generated (2048-bit minimum)
- [ ] Rate limiting configured (optional but recommended)
- [ ] Access logs monitored
- [ ] Firewall configured (UFW or iptables)
- [ ] SSH key authentication only (disable password auth)
- [ ] Non-root user for application processes
- [ ] Automatic security updates enabled

### Monitoring
- [ ] nginx access logs: `/var/log/nginx/access.log`
- [ ] nginx error logs: `/var/log/nginx/error.log`
- [ ] Application logs: systemd journal or custom logging
- [ ] Uptime monitoring (e.g., UptimeRobot, Pingdom)
- [ ] SSL certificate expiration monitoring
- [ ] Disk space monitoring
- [ ] API rate limit monitoring

---

## Troubleshooting

### API Key Not Working

**Symptoms**: 401 Unauthorized or 403 Forbidden errors

**Solutions**:
1. Verify API key is correct in vault or nginx config
2. Check API key has not expired or been revoked
3. Verify Ironforge account is active
4. Check nginx is properly appending `apiKey` parameter

**Debug**:
```bash
# Check nginx error logs
sudo tail -f /var/log/nginx/error.log

# Test nginx config
sudo nginx -t

# Test API key directly
curl "https://sanctum-api.ironforge.network/lsts/bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1?apiKey=YOUR_KEY"
```

### SSL Certificate Issues

**Symptoms**: "Your connection is not private" browser warning

**Solutions**:
1. Verify certbot succeeded: `sudo certbot certificates`
2. Check certificate paths in nginx config match certbot output
3. Renew certificate manually: `sudo certbot renew`
4. Check firewall allows port 443

### Cache Not Working

**Symptoms**: Every request hits Sanctum API (check `X-Cache-Status` header)

**Solutions**:
1. Verify cache directory exists and has correct permissions
2. Check nginx cache configuration in `nginx.conf`
3. Verify `proxy_cache` directive in site config
4. Clear cache manually: `sudo rm -rf /var/cache/nginx/sanctum/*`

### Build Failures

**Symptoms**: `npm run build` fails during deployment

**Solutions**:
1. Check Node.js version matches requirements (v18+)
2. Verify all dependencies are installed
3. Check for syntax errors in code
4. Review build output for specific errors
5. Try building locally first

---

## Future Enhancements

### Performance
- [ ] CDN integration (Cloudflare, Fastly)
- [ ] Image optimization and lazy loading
- [ ] Code splitting and lazy loading for routes
- [ ] Service worker for offline support
- [ ] HTTP/2 server push for critical assets

### Monitoring & Observability
- [ ] Application Performance Monitoring (APM) - Sentry, Datadog
- [ ] Real User Monitoring (RUM)
- [ ] Custom metrics for API call success rates
- [ ] Grafana dashboards for nginx metrics
- [ ] PagerDuty/OpsGenie for alerting

### Infrastructure
- [ ] Multi-region deployment for redundancy
- [ ] Load balancer for horizontal scaling
- [ ] Database for caching (Redis) instead of nginx cache
- [ ] CI/CD pipeline (GitHub Actions, GitLab CI)
- [ ] Automated backups
- [ ] Blue-green deployments

### Security
- [ ] Web Application Firewall (WAF)
- [ ] DDoS protection (Cloudflare)
- [ ] Rate limiting per user/IP
- [ ] Content Security Policy (CSP) headers
- [ ] Subresource Integrity (SRI) for CDN assets

---

## References

- [Sanctum Documentation](https://learn.sanctum.so/docs)
- [Ironforge Pricing](https://www.ironforge.sanctum.so/pricing)
- [nginx Documentation](https://nginx.org/en/docs/)
- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [Ansible Documentation](https://docs.ansible.com/)
- [DigitalOcean Tutorials](https://www.digitalocean.com/community/tutorials)
- [cosmos-ansible Repository](https://github.com/hyphacoop/cosmos-ansible)

---

**Last Updated**: 2025-10-30
