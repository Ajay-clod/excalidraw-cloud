# Kubernetes Manifests for Excalidraw

This directory contains Kubernetes manifests for deploying Excalidraw to a Kubernetes cluster, optimized for Google Kubernetes Engine (GKE).

## Directory Structure

```
k8s/
├── deployments/          # Deployment configurations
│   ├── configmap.yaml           # Non-sensitive configuration
│   ├── frontend-deployment.yaml # Frontend application deployment
│   ├── yjs-deployment.yaml      # YJS collaboration server deployment
│   ├── hpa-yjs.yaml            # Horizontal Pod Autoscaler for YJS
│   ├── persistent-volumes.yaml  # Persistent storage (for Redis/data)
│   └── secret-manager.yaml      # Google Secret Manager integration
├── services/             # Kubernetes Services
│   ├── frontend-service.yaml    # Frontend service
│   └── yjs-service.yaml        # YJS service
├── ingress/              # Ingress configurations
│   └── ingress.yaml            # Ingress with TLS/SSL
├── monitoring/           # Monitoring stack (optional)
│   ├── prometheus-deployment.yaml
│   ├── prometheus-service.yaml
│   ├── grafana-deployment.yaml
│   └── grafana-service.yaml
└── load testing/         # Load testing scripts
    └── load-test.js
```

## Quick Start

### Prerequisites

1. A running Kubernetes cluster (GKE recommended)
2. `kubectl` configured to access your cluster
3. Docker images built and pushed to a container registry (Google Artifact Registry recommended)

### Deployment Steps

1. **Create namespace** (optional but recommended):
   ```bash
   kubectl create namespace excalidraw
   ```

2. **Update configuration**:
   - Edit `deployments/configmap.yaml` with your domain names
   - Update image references in deployment files to point to your container registry
   - Configure secrets (see [Secret Management](#secret-management))

3. **Deploy ConfigMap**:
   ```bash
   kubectl apply -f deployments/configmap.yaml -n excalidraw
   ```

4. **Deploy applications**:
   ```bash
   kubectl apply -f deployments/frontend-deployment.yaml -n excalidraw
   kubectl apply -f deployments/yjs-deployment.yaml -n excalidraw
   ```

5. **Create services**:
   ```bash
   kubectl apply -f services/ -n excalidraw
   ```

6. **Deploy ingress**:
   ```bash
   kubectl apply -f ingress/ingress.yaml -n excalidraw
   ```

7. **Enable autoscaling** (optional):
   ```bash
   kubectl apply -f deployments/hpa-yjs.yaml -n excalidraw
   ```

8. **Verify deployment**:
   ```bash
   kubectl get pods -n excalidraw
   kubectl get services -n excalidraw
   kubectl get ingress -n excalidraw
   ```

## Configuration

### Image References

Before deploying, update the image references in deployment files to point to your container registry:

**For Google Artifact Registry:**
```yaml
image: REGION-docker.pkg.dev/PROJECT_ID/excalidraw-repo/excalidraw-frontend:TAG
```

**For Docker Hub:**
```yaml
image: your-username/excalidraw-frontend:TAG
```

### Environment Variables

Key environment variables to configure:

- `NODE_ENV`: Set to `production` for production deployments
- `VITE_APP_WS_SERVER_URL`: WebSocket server URL for collaboration (e.g., `wss://yjs.example.com`)
- `REDIS_URL`: Redis connection URL for YJS server (required for collaboration)

### Secret Management

**Option 1: Google Secret Manager (Recommended for GKE)**

Use the External Secrets Operator to sync secrets from Google Secret Manager:

1. Install External Secrets Operator:
   ```bash
   helm repo add external-secrets https://charts.external-secrets.io
   helm install external-secrets external-secrets/external-secrets \
       -n external-secrets-system --create-namespace
   ```

2. Configure Workload Identity (see `deployments/secret-manager.yaml`)

3. Create secrets in Google Secret Manager:
   ```bash
   echo -n "your-secret-value" | gcloud secrets create excalidraw-api-key --data-file=-
   ```

4. Apply secret configuration:
   ```bash
   kubectl apply -f deployments/secret-manager.yaml -n excalidraw
   ```

**Option 2: Kubernetes Secrets**

For development or non-sensitive configuration:

```bash
kubectl create secret generic excalidraw-secrets \
    -n excalidraw \
    --from-literal=api-key=your-api-key \
    --from-literal=redis-url=redis://redis:6379
```

### Persistent Storage

If you need persistent storage (e.g., for Redis):

1. Apply persistent volume claims:
   ```bash
   kubectl apply -f deployments/persistent-volumes.yaml -n excalidraw
   ```

2. Update your deployment to mount the volume:
   ```yaml
   volumes:
     - name: redis-storage
       persistentVolumeClaim:
         claimName: redis-data
   ```

## Resource Requirements

### Frontend

- **Requests**: 128Mi memory, 100m CPU
- **Limits**: 256Mi memory, 500m CPU
- **Recommended replicas**: 2-5 (based on traffic)

### YJS Server

- **Requests**: 256Mi memory, 200m CPU
- **Limits**: 512Mi memory, 1000m CPU
- **Recommended replicas**: 3-10 (based on collaboration load)

Adjust these values based on your actual load and requirements. Run load tests to determine optimal settings.

## Autoscaling

### Horizontal Pod Autoscaler (HPA)

The YJS deployment includes HPA configuration that automatically scales based on CPU usage:

- **Min replicas**: 2
- **Max replicas**: 10
- **Target CPU**: 60%

To adjust:
```bash
kubectl edit hpa excalidraw-yjs-hpa -n excalidraw
```

### Cluster Autoscaler

For GKE, enable cluster autoscaling to automatically add/remove nodes:

```bash
gcloud container clusters update excalidraw-cluster \
    --enable-autoscaling \
    --min-nodes=1 \
    --max-nodes=5 \
    --region=us-central1
```

## Ingress and TLS

### NGINX Ingress Controller

The default ingress configuration uses NGINX Ingress Controller:

1. Install NGINX Ingress:
   ```bash
   helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
   helm install nginx-ingress ingress-nginx/ingress-nginx \
       --namespace ingress-nginx --create-namespace
   ```

2. The ingress will automatically create a Google Cloud Load Balancer

### TLS/SSL Certificates

**Option 1: cert-manager with Let's Encrypt (Recommended)**

Automatically provisions and renews SSL certificates:

```bash
# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml

# Create ClusterIssuer (see GCP deployment guide)
```

**Option 2: Google-managed certificates**

Use GCP's managed SSL certificates (only with GCE ingress):

```yaml
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: excalidraw-cert
spec:
  domains:
    - your-domain.com
```

## Monitoring

### Deploy Prometheus and Grafana (Optional)

```bash
kubectl apply -f monitoring/ -n excalidraw
```

Access Grafana:
```bash
kubectl port-forward svc/grafana 3000:3000 -n excalidraw
```

Default credentials: admin/admin

### Google Cloud Monitoring

If using GKE with Stackdriver enabled, logs and metrics are automatically collected:

```bash
# View logs
gcloud logging read "resource.type=k8s_container AND resource.labels.namespace_name=excalidraw" --limit 50

# View in Cloud Console
# Navigate to: Logging > Logs Explorer
```

## Troubleshooting

### Check pod status
```bash
kubectl get pods -n excalidraw
kubectl describe pod <pod-name> -n excalidraw
kubectl logs <pod-name> -n excalidraw
```

### Check services
```bash
kubectl get svc -n excalidraw
kubectl describe svc excalidraw-frontend -n excalidraw
```

### Check ingress
```bash
kubectl get ingress -n excalidraw
kubectl describe ingress excalidraw-ingress -n excalidraw
```

### Common Issues

1. **ImagePullBackOff**: Check image URL and registry authentication
2. **CrashLoopBackOff**: Check logs with `kubectl logs`
3. **Service not accessible**: Verify service and ingress configuration
4. **SSL certificate issues**: Check cert-manager or ManagedCertificate status

## Load Testing

Test your deployment with the included load test script:

```bash
# Install dependencies
npm install -g artillery

# Run load test
artillery run k8s/load\ testing/load-test.js
```

## Production Checklist

Before going to production:

- [ ] Update all placeholder values (domain names, image URLs, secrets)
- [ ] Configure proper resource limits based on load testing
- [ ] Set up TLS/SSL certificates
- [ ] Configure secrets using Google Secret Manager
- [ ] Enable monitoring and logging
- [ ] Set up alerting for critical metrics
- [ ] Configure backup strategy for persistent data
- [ ] Test disaster recovery procedures
- [ ] Review and apply security best practices
- [ ] Set up CI/CD pipeline for automated deployments

## Additional Resources

- [Google Cloud Deployment Guide](../docs/gcp-deploy.md) - Comprehensive GCP deployment instructions
- [GKE Documentation](https://cloud.google.com/kubernetes-engine/docs)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [Excalidraw Documentation](https://docs.excalidraw.com)

## Support

For issues specific to Kubernetes deployment, please check:
1. This README
2. The [GCP deployment guide](../docs/gcp-deploy.md)
3. [GitHub Issues](https://github.com/excalidraw/excalidraw/issues)
