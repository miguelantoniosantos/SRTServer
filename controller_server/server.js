const settings = require('./settings.json');
const fs = require('fs');
const servers = {};
const { exec } = require('child_process');
const express = require('express');
const net = require('net');

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
    if (server.max_rtt < rtt) {
        rtt = server.max_rtt;
    }
    const configContent = baseConfig.replaceAll("TIMEOUT_HERE", timeout)
        .replaceAll('RTT_HERE', rtt)
        .replaceAll('DRONE_NAME_HERE', server.name)
        .replaceAll('DRONE_STREAM_KEY_HERE', server.stream_key);
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
            "stream_key": server.stream_key,
            "max_timeout": server.max_timeout,
            "min_rtt": server.min_rtt,
            "max_rtt": server.max_rtt,
            process: null,
            status: 0, // 0 => not running, 1 => started, 2 => restarting
            avgPing: null,
            pings: [],
            currentRTT: 0
        };
    }
}

async function startProcess(server) {
    const startBash = `docker run --rm --name ${server.name} -p ${server.port}:10080/udp -v ./config/srt_${server.name}.conf:/config/srt.conf  ossrs/srs:5 ./objs/srs -c /config/srt.conf`;
    server.process = exec(startBash, (error, stdout, stderr) => {
        if (error) {
            server.status = 0;
            return;
        }
        if (stderr) {
            server.status = 0;
            return;
        }
    });
    server.status = 1;
}

async function stopProcess(server) {
    return new Promise(function (resolve) {
        const stopBash = `docker rm $(docker container ls -q --filter name=${server.name}) --force`;
        exec(stopBash, (error, stdout, stderr) => {
            if (error) {
                server.status = 0;
                resolve(false);
                return;
            }
            if (stderr) {
                server.status = 0;
                resolve(false);
                return;
            }
            resolve(true);
        });
    });
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


async function restartServer(server, rtt, timeout) {
    if (settings.restartServers) {
        await generateServerConfig(server, rtt, timeout);
        server.status = 2;
        const pid = server.process.pid;
        console.log(`Server ${server.name} stopping for restart`);
        await stopProcess(server);
        console.log(`Server ${server.name} stopped for restart`);
        await startProcess(server);
        console.log(`Server ${server.name} restarted on port ${server.port}`);
        server.status = 1;
    }
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
    console.log(`Ping from ${server.name} is ${ping}ms`);
    server.pings.push(ping);
    if (server.pings.length > 150) {
        server.pings.shift();
    }
    server.avgPing = average(server.pings);
    console.log(`Average ping from ${server.name} is ${server.avgPing}ms`);
    const rtt = (server.avgPing + 10) * 1.5;
    const timeout = rtt * 100;
    let requiresRestart = false;
    const currentRTT = server.currentRTT;
    const variance = Math.abs(1 - (rtt * 1 / currentRTT));
    if (variance >= settings.varianceNeededForRestart) {
        requiresRestart = true;
    }
    if (requiresRestart) {
        restartServer(server, rtt, timeout);
    }
    res.send('OK');
});


async function main() {
    await config();
    await boot();
}

main();