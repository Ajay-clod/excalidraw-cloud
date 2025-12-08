# Google Cloud Platform (GCP) Deployment Guide

This guide provides step-by-step instructions for deploying Excalidraw to Google Kubernetes Engine (GKE) on Google Cloud Platform.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Setup](#detailed-setup)
  - [1. GCP Project Setup](#1-gcp-project-setup)
  - [2. Build and Push Docker Image](#2-build-and-push-docker-image)
  - [3. GKE Cluster Creation](#3-gke-cluster-creation)
  - [4. Configure kubectl](#4-configure-kubectl)
  - [5. Deploy to GKE](#5-deploy-to-gke)
  - [6. Configure Ingress and Load Balancer](#6-configure-ingress-and-load-balancer)
  - [7. Set Up Persistent Storage](#7-set-up-persistent-storage)
  - [8. Configure Secrets Management](#8-configure-secrets-management)
  - [9. Monitoring and Logging](#9-monitoring-and-logging)
- [Advanced: Infrastructure as Code with Terraform](#advanced-infrastructure-as-code-with-terraform)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before you begin, ensure you have:

- A Google Cloud Platform account with billing enabled
- [Google Cloud SDK (gcloud CLI)](https://cloud.google.com/sdk/docs/install) installed and configured
- [kubectl](https://kubernetes.io/docs/tasks/tools/) installed
- [Docker](https://docs.docker.com/get-docker/) installed
- [Helm](https://helm.sh/docs/intro/install/) (optional, for advanced deployments)

## Quick Start

For experienced users, here's a minimal deployment:

```bash
# Set variables
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export CLUSTER_NAME="excalidraw-cluster"
export IMAGE_NAME="excalidraw-frontend"

# Authenticate and set project
gcloud auth login
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable container.googleapis.com artifactregistry.googleapis.com

# Create Artifact Registry repository
gcloud artifacts repositories create excalidraw-repo \
    --repository-format=docker \
    --location=$REGION \
    --description="Excalidraw Docker images"

# Build and push image
gcloud auth configure-docker ${REGION}-docker.pkg.dev
docker build -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo/${IMAGE_NAME}:latest .
docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo/${IMAGE_NAME}:latest

# Create GKE cluster
gcloud container clusters create $CLUSTER_NAME \
    --region=$REGION \
    --num-nodes=2 \
    --machine-type=e2-medium \
    --enable-autoscaling \
    --min-nodes=1 \
    --max-nodes=5

# Get credentials
gcloud container clusters get-credentials $CLUSTER_NAME --region=$REGION

# Update k8s manifests with your image and deploy
kubectl apply -f k8s/deployments/
kubectl apply -f k8s/services/
kubectl apply -f k8s/ingress/
```

## Detailed Setup

### 1. GCP Project Setup

#### Create a new GCP project (or use existing)

```bash
# Set your project ID
export PROJECT_ID="excalidraw-prod"
export REGION="us-central1"
export ZONE="us-central1-a"

# Create project (skip if using existing)
gcloud projects create $PROJECT_ID --name="Excalidraw Production"

# Set active project
gcloud config set project $PROJECT_ID

# Link billing account (required - replace BILLING_ACCOUNT_ID)
gcloud billing projects link $PROJECT_ID \
    --billing-account=BILLING_ACCOUNT_ID
```

#### Enable required Google Cloud APIs

```bash
gcloud services enable \
    container.googleapis.com \
    artifactregistry.googleapis.com \
    compute.googleapis.com \
    secretmanager.googleapis.com \
    logging.googleapis.com \
    monitoring.googleapis.com
```

#### Create a service account for deployment

```bash
# Create service account
gcloud iam service-accounts create excalidraw-deployer \
    --display-name="Excalidraw Deployment Service Account"

# Grant necessary roles
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:excalidraw-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/container.developer"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:excalidraw-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:excalidraw-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"

# Download service account key (for CI/CD)
gcloud iam service-accounts keys create ~/excalidraw-deployer-key.json \
    --iam-account=excalidraw-deployer@${PROJECT_ID}.iam.gserviceaccount.com
```

### 2. Build and Push Docker Image

#### Create Google Artifact Registry repository

```bash
# Create repository
gcloud artifacts repositories create excalidraw-repo \
    --repository-format=docker \
    --location=$REGION \
    --description="Excalidraw Docker images"

# Configure Docker authentication
gcloud auth configure-docker ${REGION}-docker.pkg.dev
```

#### Build and push the frontend image

```bash
# Build the Docker image
docker build \
    --platform linux/amd64 \
    -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo/excalidraw-frontend:latest \
    -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo/excalidraw-frontend:$(git rev-parse --short HEAD) \
    .

# Push both tags
docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo/excalidraw-frontend:latest
docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo/excalidraw-frontend:$(git rev-parse --short HEAD)
```

#### Build YJS collaboration server (if needed)

If you're using the collaboration features, you'll need to build and deploy the YJS server separately:

```bash
# TODO: Add instructions for building YJS server image if applicable
# This depends on your specific YJS server implementation
```

### 3. GKE Cluster Creation

#### Create a production-ready GKE cluster

```bash
export CLUSTER_NAME="excalidraw-cluster"

gcloud container clusters create $CLUSTER_NAME \
    --region=$REGION \
    --num-nodes=2 \
    --machine-type=e2-medium \
    --disk-type=pd-standard \
    --disk-size=50GB \
    --enable-autoscaling \
    --min-nodes=1 \
    --max-nodes=5 \
    --enable-autorepair \
    --enable-autoupgrade \
    --enable-ip-alias \
    --network=default \
    --subnetwork=default \
    --enable-stackdriver-kubernetes \
    --addons=HorizontalPodAutoscaling,HttpLoadBalancing,GcePersistentDiskCsiDriver \
    --workload-pool=${PROJECT_ID}.svc.id.goog \
    --enable-shielded-nodes
```

**Options explained:**
- `--region`: Multi-zonal cluster for high availability
- `--enable-autoscaling`: Automatically scale nodes based on load
- `--enable-autorepair`: Automatically repair unhealthy nodes
- `--enable-autoupgrade`: Keep cluster up to date with latest Kubernetes version
- `--enable-stackdriver-kubernetes`: Enable Google Cloud's monitoring and logging
- `--workload-pool`: Enable Workload Identity for secure access to GCP services

#### Alternative: Create a zonal cluster (lower cost)

```bash
gcloud container clusters create $CLUSTER_NAME \
    --zone=$ZONE \
    --num-nodes=2 \
    --machine-type=e2-medium \
    --enable-autoscaling \
    --min-nodes=1 \
    --max-nodes=3
```

### 4. Configure kubectl

```bash
# Get cluster credentials
gcloud container clusters get-credentials $CLUSTER_NAME --region=$REGION

# Verify connection
kubectl cluster-info
kubectl get nodes
```

### 5. Deploy to GKE

#### Update Kubernetes manifests

Before deploying, update the image references in your deployment files:

```bash
# Update frontend deployment image
export IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo/excalidraw-frontend:latest"

# You can use sed to update the manifests, or manually edit them
sed -i "s|your-dockerhub/excalidraw-frontend:latest|${IMAGE_URI}|g" \
    k8s/deployments/frontend-deployment.yaml
```

#### Deploy the application

```bash
# Create namespace (optional but recommended)
kubectl create namespace excalidraw

# Apply ConfigMap
kubectl apply -f k8s/deployments/configmap.yaml -n excalidraw

# Deploy frontend
kubectl apply -f k8s/deployments/frontend-deployment.yaml -n excalidraw
kubectl apply -f k8s/services/frontend-service.yaml -n excalidraw

# Deploy YJS server (if applicable)
kubectl apply -f k8s/deployments/yjs-deployment.yaml -n excalidraw
kubectl apply -f k8s/services/yjs-service.yaml -n excalidraw

# Apply HPA for autoscaling
kubectl apply -f k8s/deployments/hpa-yjs.yaml -n excalidraw

# Check deployment status
kubectl get deployments -n excalidraw
kubectl get pods -n excalidraw
kubectl get services -n excalidraw
```

### 6. Configure Ingress and Load Balancer

#### Install NGINX Ingress Controller (recommended)

```bash
# Add Helm repository
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# Install NGINX Ingress Controller
helm install nginx-ingress ingress-nginx/ingress-nginx \
    --namespace ingress-nginx \
    --create-namespace \
    --set controller.service.type=LoadBalancer \
    --set controller.service.annotations."cloud\.google\.com/load-balancer-type"="External"

# Wait for external IP to be assigned
kubectl get service nginx-ingress-ingress-nginx-controller \
    -n ingress-nginx --watch
```

#### Alternative: Use GCP HTTP(S) Load Balancer

Update your ingress to use the GCE ingress class:

```yaml
# In k8s/ingress/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: excalidraw-ingress
  annotations:
    kubernetes.io/ingress.class: "gce"
    kubernetes.io/ingress.global-static-ip-name: "excalidraw-ip"
spec:
  # ... rest of configuration
```

Reserve a static IP address:

```bash
# Reserve global static IP
gcloud compute addresses create excalidraw-ip --global

# Get the IP address
gcloud compute addresses describe excalidraw-ip --global
```

#### Set up TLS/SSL certificate

**Option 1: Google-managed certificate (recommended for production)**

```bash
# Create managed certificate
cat <<EOF | kubectl apply -f -
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: excalidraw-cert
  namespace: excalidraw
spec:
  domains:
    - your-domain.com
    - yjs.your-domain.com
EOF

# Update ingress to use managed certificate
# Add annotation: networking.gke.io/managed-certificates: excalidraw-cert
```

**Option 2: Let's Encrypt with cert-manager**

```bash
# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml

# Create ClusterIssuer
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
EOF
```

#### Apply the ingress

```bash
# Update ingress with your domain and certificate settings
kubectl apply -f k8s/ingress/ingress.yaml -n excalidraw

# Check ingress status
kubectl get ingress -n excalidraw
kubectl describe ingress excalidraw-ingress -n excalidraw
```

### 7. Set Up Persistent Storage

For persistent data storage (if needed for Redis or other stateful services):

#### Create a PersistentVolumeClaim

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis-data
  namespace: excalidraw
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: standard-rwo
  resources:
    requests:
      storage: 10Gi
EOF
```

**Available GCP storage classes:**
- `standard-rwo`: Standard persistent disk (balanced cost/performance)
- `premium-rwo`: SSD persistent disk (better performance)
- `standard`: For ReadWriteMany access (file storage)

#### Use Persistent Disk in deployment

Add volume mount to your deployment YAML:

```yaml
volumes:
  - name: redis-storage
    persistentVolumeClaim:
      claimName: redis-data
containers:
  - name: redis
    volumeMounts:
      - name: redis-storage
        mountPath: /data
```

### 8. Configure Secrets Management

#### Using Google Secret Manager

**Create secrets in Secret Manager:**

```bash
# Create a secret
echo -n "your-secret-value" | gcloud secrets create excalidraw-api-key \
    --data-file=- \
    --replication-policy="automatic"

# Grant access to the GKE service account
gcloud secrets add-iam-policy-binding excalidraw-api-key \
    --member="serviceAccount:${PROJECT_ID}.svc.id.goog[excalidraw/default]" \
    --role="roles/secretmanager.secretAccessor"
```

**Configure Workload Identity:**

```bash
# Create Kubernetes service account
kubectl create serviceaccount excalidraw-ksa -n excalidraw

# Bind to Google service account
gcloud iam service-accounts add-iam-policy-binding \
    excalidraw-deployer@${PROJECT_ID}.iam.gserviceaccount.com \
    --role roles/iam.workloadIdentityUser \
    --member "serviceAccount:${PROJECT_ID}.svc.id.goog[excalidraw/excalidraw-ksa]"

# Annotate Kubernetes service account
kubectl annotate serviceaccount excalidraw-ksa \
    -n excalidraw \
    iam.gke.io/gcp-service-account=excalidraw-deployer@${PROJECT_ID}.iam.gserviceaccount.com
```

**Use External Secrets Operator (recommended):**

```bash
# Install External Secrets Operator
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets \
    external-secrets/external-secrets \
    -n external-secrets-system \
    --create-namespace

# Create SecretStore
cat <<EOF | kubectl apply -f -
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: gcpsm-secret-store
  namespace: excalidraw
spec:
  provider:
    gcpsm:
      projectID: "${PROJECT_ID}"
      auth:
        workloadIdentity:
          clusterLocation: ${REGION}
          clusterName: ${CLUSTER_NAME}
          serviceAccountRef:
            name: excalidraw-ksa
EOF

# Create ExternalSecret
cat <<EOF | kubectl apply -f -
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: excalidraw-secrets
  namespace: excalidraw
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: gcpsm-secret-store
    kind: SecretStore
  target:
    name: excalidraw-app-secrets
    creationPolicy: Owner
  data:
  - secretKey: api-key
    remoteRef:
      key: excalidraw-api-key
EOF
```

#### Alternative: Using Kubernetes Secrets

For non-sensitive configuration or development:

```bash
# Create secret from literal values
kubectl create secret generic excalidraw-secrets \
    -n excalidraw \
    --from-literal=api-key=your-api-key \
    --from-literal=db-password=your-db-password

# Or from file
kubectl create secret generic excalidraw-secrets \
    -n excalidraw \
    --from-file=./secrets/api-key.txt
```

### 9. Monitoring and Logging

#### Enable Google Cloud Logging

Logs are automatically collected by Google Cloud Logging when Stackdriver is enabled.

**View logs:**

```bash
# View logs in Cloud Console
gcloud logging read "resource.type=k8s_container AND resource.labels.namespace_name=excalidraw" \
    --limit 50 \
    --format json

# Or use kubectl
kubectl logs -f deployment/excalidraw-frontend -n excalidraw
```

#### Enable Google Cloud Monitoring

**Create a monitoring dashboard:**

1. Go to Google Cloud Console → Monitoring → Dashboards
2. Create a new dashboard
3. Add charts for:
   - CPU usage
   - Memory usage
   - Pod count
   - Request rate
   - Error rate

**Set up alerts:**

```bash
# Example: Create CPU alert policy
gcloud alpha monitoring policies create \
    --notification-channels=CHANNEL_ID \
    --display-name="High CPU Usage" \
    --condition-display-name="CPU > 80%" \
    --condition-threshold-value=0.8 \
    --condition-threshold-duration=300s
```

#### Optional: Deploy Prometheus and Grafana

The repository includes Prometheus and Grafana manifests in `k8s/monitoring/`:

```bash
# Deploy monitoring stack
kubectl apply -f k8s/monitoring/prometheus-deployment.yaml -n excalidraw
kubectl apply -f k8s/monitoring/prometheus-service.yaml -n excalidraw
kubectl apply -f k8s/monitoring/grafana-deployment.yaml -n excalidraw
kubectl apply -f k8s/monitoring/grafana-service.yaml -n excalidraw

# Access Grafana (port-forward for testing)
kubectl port-forward svc/grafana 3000:3000 -n excalidraw
# Open http://localhost:3000 (default credentials: admin/admin)
```

## Advanced: Infrastructure as Code with Terraform

For automated infrastructure provisioning, consider using Terraform:

### Sample Terraform Configuration

Create a `terraform/` directory with the following structure:

```
terraform/
├── main.tf
├── variables.tf
├── outputs.tf
└── terraform.tfvars
```

**main.tf:**

```hcl
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "required_apis" {
  for_each = toset([
    "container.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# Artifact Registry repository
resource "google_artifact_registry_repository" "excalidraw_repo" {
  location      = var.region
  repository_id = "excalidraw-repo"
  format        = "DOCKER"
  description   = "Excalidraw Docker images"
  
  depends_on = [google_project_service.required_apis]
}

# GKE cluster
resource "google_container_cluster" "excalidraw_cluster" {
  name     = var.cluster_name
  location = var.region
  
  # Remove default node pool immediately
  remove_default_node_pool = true
  initial_node_count       = 1
  
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }
  
  depends_on = [google_project_service.required_apis]
}

# Node pool
resource "google_container_node_pool" "primary_nodes" {
  name       = "primary-node-pool"
  location   = var.region
  cluster    = google_container_cluster.excalidraw_cluster.name
  node_count = var.node_count
  
  autoscaling {
    min_node_count = var.min_nodes
    max_node_count = var.max_nodes
  }
  
  node_config {
    machine_type = var.machine_type
    disk_size_gb = 50
    
    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]
    
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# Static IP for load balancer
resource "google_compute_global_address" "excalidraw_ip" {
  name = "excalidraw-ip"
}
```

**variables.tf:**

```hcl
variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP Region"
  type        = string
  default     = "us-central1"
}

variable "cluster_name" {
  description = "GKE Cluster Name"
  type        = string
  default     = "excalidraw-cluster"
}

variable "node_count" {
  description = "Number of nodes per zone"
  type        = number
  default     = 1
}

variable "min_nodes" {
  description = "Minimum number of nodes"
  type        = number
  default     = 1
}

variable "max_nodes" {
  description = "Maximum number of nodes"
  type        = number
  default     = 5
}

variable "machine_type" {
  description = "GCE machine type"
  type        = string
  default     = "e2-medium"
}
```

**Deploy with Terraform:**

```bash
cd terraform

# Initialize Terraform
terraform init

# Review the plan
terraform plan -var="project_id=your-project-id"

# Apply the configuration
terraform apply -var="project_id=your-project-id"

# Get cluster credentials
gcloud container clusters get-credentials excalidraw-cluster --region=us-central1
```

## Troubleshooting

### Common Issues

**1. Pods not starting**

```bash
# Check pod status
kubectl get pods -n excalidraw
kubectl describe pod <pod-name> -n excalidraw

# Check logs
kubectl logs <pod-name> -n excalidraw
```

**2. Image pull errors**

```bash
# Verify Artifact Registry authentication
gcloud auth configure-docker ${REGION}-docker.pkg.dev

# Check if image exists
gcloud artifacts docker images list ${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo
```

**3. Service not accessible**

```bash
# Check service
kubectl get svc -n excalidraw
kubectl describe svc excalidraw-frontend -n excalidraw

# Check ingress
kubectl get ingress -n excalidraw
kubectl describe ingress excalidraw-ingress -n excalidraw

# Check ingress controller logs
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx
```

**4. SSL certificate issues**

```bash
# Check certificate status (for cert-manager)
kubectl get certificate -n excalidraw
kubectl describe certificate -n excalidraw

# Check managed certificate status (for GCP managed certs)
kubectl get managedcertificate -n excalidraw
kubectl describe managedcertificate excalidraw-cert -n excalidraw
```

**5. Workload Identity issues**

```bash
# Verify service account binding
gcloud iam service-accounts get-iam-policy \
    excalidraw-deployer@${PROJECT_ID}.iam.gserviceaccount.com

# Check pod service account
kubectl get pod <pod-name> -n excalidraw -o yaml | grep serviceAccountName
```

### Useful Commands

```bash
# Scale deployment
kubectl scale deployment excalidraw-frontend --replicas=5 -n excalidraw

# Update image
kubectl set image deployment/excalidraw-frontend \
    frontend=${REGION}-docker.pkg.dev/${PROJECT_ID}/excalidraw-repo/excalidraw-frontend:new-tag \
    -n excalidraw

# Rollback deployment
kubectl rollout undo deployment/excalidraw-frontend -n excalidraw

# Check resource usage
kubectl top nodes
kubectl top pods -n excalidraw

# Port forward for debugging
kubectl port-forward svc/excalidraw-frontend 8080:80 -n excalidraw
```

### Cost Optimization Tips

1. **Use preemptible/spot instances** for non-critical workloads
2. **Enable cluster autoscaling** to scale down during low traffic
3. **Use appropriate machine types** - don't over-provision
4. **Set resource requests/limits** to pack pods efficiently
5. **Use regional clusters only when needed** - zonal clusters cost less
6. **Clean up unused resources** - load balancers, IPs, disks

### Support and Resources

- [GKE Documentation](https://cloud.google.com/kubernetes-engine/docs)
- [Google Artifact Registry](https://cloud.google.com/artifact-registry/docs)
- [Google Secret Manager](https://cloud.google.com/secret-manager/docs)
- [Excalidraw GitHub Repository](https://github.com/excalidraw/excalidraw)
- [Kubernetes Documentation](https://kubernetes.io/docs/home/)

## Next Steps

After successful deployment:

1. Configure domain DNS to point to the load balancer IP
2. Set up monitoring alerts for production readiness
3. Implement backup strategy for persistent data
4. Configure CI/CD pipeline for automated deployments
5. Review and optimize resource allocation based on actual usage
6. Implement additional security measures (network policies, pod security policies)
7. Set up disaster recovery procedures

---

For questions or issues with this deployment guide, please open an issue in the [GitHub repository](https://github.com/excalidraw/excalidraw/issues).
