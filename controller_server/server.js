const settings = require('./settings.json');
const fs = require('fs');
const servers = {};
const { spawn } = require('child_process');
const express = require('express');
const e = require('express');
const app = express()
app.use(express.json());

const usedPorts = [];
const baseTimeout = settings.baseTimeout;
const baseRTT = settings.baseRTT;



async function generateServerConfig(server, timeout, rtt) {
    const baseConfig = fs.readFileSync('./config/srt.base.conf', { encoding: 'utf8' });
    if (server.max_timeout < timeout) {
        timeout = server.max_timeout;
    }
    if (server.min_rtt > rtt) {
        rtt = server.min_rtt;
    }
    const configContent = baseConfig.replaceAll("TIMEOUT_HERE", timeout).replaceAll('RTT_HERE', rtt);
    fs.writeFileSync(`./config/srt_${server.name}.conf`, configContent);
    server.currentRTT = rtt;
}

async function config() {
    for (const server of settings.servers) {
        const port = server.port;
        const name = server.name;
        if (port in usedPorts) {
            console.log("Duplicated entry ports");
            return;
        }
        servers[name] =
        {
            "name": name,
            "port": port,
            "api_key": server.key,
            "max_timeout": server.max_timeout,
            "min_rtt": server.min_rtt,
            process: null,
            status: 0, // 0 => not running, 1 => started, 2 => restarting,
            avgPing: null,
            pings: [],
            currentRTT: 0
        };
    }
}

async function startProcess(server) {
    const startBash = `run -rm -p 1935:1935 -p 8080:8080 -p ${server.port}:10080/udp -v ./config/srt_${server.name}.conf:/config/srt.conf  ossrs/srs:5 ./objs/srs -c /config/srt.conf`;
    server.process = spawn('docker', startBash.split(' '));
    server.status = 1;
}

async function boot() {
    for (const serverName in servers) {
        const server = servers[serverName];
        await generateServerConfig(server, baseTimeout, baseRTT);
        await startProcess(server);
        console.log(`Server ${server.name} started on port ${server.port}`);
    }

    app.listen(settings.httpServerPort, () => {
        console.log(`Http Controller listening on port ${settings.httpServerPort}`)
    })
}


async function isPortFree(port) {
    return new Promise(resolve => {
        const server = require('http')
            .createServer()
            .listen(port, () => {
                server.close()
                resolve(true)
            })
            .on('error', () => {
                resolve(false)
            })
    })
}

async function waitForMS(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    })
}

async function restartServer(server, rtt, timeout) {
    await generateServerConfig(server, rtt, timeout);
    server.status = 2;
    console.log("sending kill");
    server.process.kill();
    console.log(`Server ${server.name} stopping for restart`);
    while (!await isPortFree(server.port)) {
        await waitForMS(100);
    }
    console.log(`Server ${server.name} stopped for restart`);
    await startProcess(server);
    console.log(`Server ${server.name} restarted on port ${server.port}`);
    server.status = 1;
}

const average = array => array.reduce((a, b) => a + b) / array.length;

app.post('/ping', async (req, res) => {
    const now = Date.now();
    if (!('x-client-id' in req.headers)) {
        res.send('OK');
        return;
    }
    const xClientID = req.headers['x-client-id'];
    let server = null;

    for (const serverName in servers) {
        if (servers[serverName].api_key == xClientID) {
            server = servers[serverName];
            break;
        }
    }
    if (server === null) {
        res.send('OK');
        return;
    }
    const requestTime = req.body.time;
    const ping = now - requestTime;
    server.pings.push(ping);
    if (server.pings.length > 50) {
        server.pings.shift();
    }    
    server.avgPing = average(server.pings);
    const rtt = (server.avgPing + 10) * 3;
    const timeout = rtt * 100;
    let requiresRestart = false;
    const currentRTT = server.currentRTT;
    const variance = Math.abs(1 - (rtt * 1 / currentRTT));
    if (variance >= settings.varianceNeededForRestart) {
        requiresRestart = true;
    }
    if (requiresRestart) {
        console.log("here");
        restartServer(server, rtt, timeout);
    }
    res.send('OK');
});




async function main() {
    await config();
    await boot();
}

main();