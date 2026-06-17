# BestCode Control Panel (BCP)

BestCode Control Panel (BCP) is a high-performance, premium infrastructure management platform that merges advanced web hosting control (similar to CloudPanel) with Docker-based game server orchestration (similar to Pterodactyl).

---

## 🚀 Installation Guide

To start the installation, you must be logged in as `root` or a user with super-user privileges. You can perform the installation either directly from the system console or remotely via SSH:

### Step 1: Connect to your Server
Access your clean server (Debian 12, Ubuntu 22.04 LTS, or Ubuntu 24.04 LTS) via SSH:
```bash
ssh root@your.server.ip
```

### Step 2: Download the Installer
Download the automated installation script:
```bash
wget https://raw.githubusercontent.com/username/bestcode-cp/main/scripts/install.sh -O bcp-install.sh
```

*If the download fails due to an SSL certificate error, ensure you have the `ca-certificates` package installed on your system:*
```bash
apt-get update && apt-get install -y ca-certificates
```

### Step 3: Run the Script
Make the script executable and run it:
```bash
chmod +x bcp-install.sh
bash bcp-install.sh
```

Upon completion, you will receive on-screen instructions displaying the initial administrator login credentials and the access URL (default: `http://your-server-ip:3000`).

---

## 🤝 Contributions & Support

BestCode CP is an open-source project. If you encounter any bugs or wish to request new features, feel free to open an issue or submit a pull request!

### How to Contribute:
1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/AmazingFeature`).
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4. Push to the branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

---

## 🔄 How to Upgrade BCP

BCP runs as a system background application managed via PM2. To pull the latest stable updates from the repository:
```bash
cd /opt/bestcode-cp
git pull
npm install --prefix backend
pm2 restart all
```

---

## 🛡️ License & Copyright
BestCode Control Panel is licensed under the **MIT License**. You are free to modify, distribute, and use it for personal or commercial projects. See the LICENSE file for details.

