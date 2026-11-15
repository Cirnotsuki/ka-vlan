import fs from 'fs';
import path from 'path';
import mkdirp from '../modules/mkdirp';

import * as Helper from './helper';

export function copy(source, dest) {
    return new Promise((resolve, reject) => {
        mkdirp(path.dirname(dest))
            .then(() => {
                fs.copyFile(source, dest, (err) => {
                    err ? reject(err.message) : resolve();
                });
            })
            .catch((err) => {
                reject(err.message);
            });
    });
}

export function del(filePath) {
    return new Promise((resolve, reject) => {
        fs.stat(filePath, (err, stat) => {
            if (err) reject(err.message);

            if (stat.isFile()) {
                fs.unlink(filePath, (e) => {
                    e ? reject(e.message) : resolve();
                });
            } else {
                fs.readdir(filePath, (e, fileList) => {
                    if (e) reject(e.message);

                    Promise.all(fileList.map((item) => del(path.join(filePath, item))))
                        .then(() => {
                            fs.rmdir(filePath, resolve);
                        })
                        .catch((ea) => {
                            reject(ea.message);
                        });
                });
            }
        });
    });
}

export function size(filePath) {
    return new Promise((resolve, reject) => {
        sizeByte(filePath)
            .then((fSize) => {
                let fsize = fSize;
                let funit = 'B';

                if (fsize > 1000) {
                    fsize /= 1000;
                    funit = 'KB';
                }
                if (fsize > 1000) {
                    fsize /= 1000;
                    funit = 'MB';
                }
                if (fsize > 1000) {
                    fsize /= 1000;
                    funit = 'GB';
                }
                /\./.test(fsize) && (fsize = fsize.toFixed(1));

                resolve(`${fsize} ${funit}`);
            })
            .catch((err) => {
                reject(err);
            });
    });
}

export function sizeByte(filePath) {
    return new Promise((resolve, reject) => {
        fs.stat(filePath, (err, stat) => {
            err ? reject(err) : resolve(stat.size);
        });
    });
}

export function statSync(filePath) {
    return fs.statSync(filePath);
}

export function getRepeatName(fpath, fname, fext) {
    let [newName, fidx] = ['', 0];

    (function findChildName(cname) {
        if (!fs.existsSync(path.join(fpath, cname + fext))) {
            newName = cname;
        } else {
            findChildName(`${fname}-${++fidx}`);
        }
    }(fname));

    return newName;
}

export function rename(source, dest) {
    return new Promise((resolve, reject) => {
        fs.rename(source, dest, (err) => {
            err ? reject(err.message) : resolve();
        });
    });
}

export function readFile(fpath) {
    return new Promise((resolve, reject) => {
        fs.readFile(fpath, (err, data) => {
            err ? reject(err.message) : resolve(data);
        });
    });
}

export function readFileSync(fpath, format) {
    try {
        return fs.readFileSync(fpath, format);
    } catch (err) {
        return '';
    }
}

export function log(msg, type = '', extend = '') {
    const logPath = Helper.getRootFolder('log');

    type = `${type}`;

    const filename = `${path.join(logPath, Helper.getCurDate().split('-').join('/'))}${extend}.log`;

    const errmsg = [
        '',
        `----------------------${Helper.getCurDateTime()}----------------------`,
        `${type}:${msg}`,
        msg.fileName,
        // msg.stack,
    ];

    if (msg instanceof TypeError) {
        errmsg.push(msg.fileName || '');
        // errmsg.push(msg.stack);
    }

    errmsg.push('', '');

    mkdirp(path.dirname(filename)).then(() => {
        const breakLine = '\n';
        const enter = '\r';

        errmsg.forEach((line) => {
            if (!line) return;
            fs.appendFileSync(filename, breakLine + breakLine + enter, 'utf-8');
            fs.appendFileSync(filename, line, 'utf-8');
            fs.appendFileSync(filename, breakLine + breakLine + enter, 'utf-8');
        });
        fs.appendFileSync(filename, breakLine + breakLine + enter, 'utf-8');
    });

    // 调试模式是抛出异常 最终打包了，注释掉
    if (process.env.NODE_ENV === 'development') {
        console.error(msg);
        // if (msg instanceof TypeError) {
        //     throw msg;
        // }
    }
}

export function mkdir(dpath) {
    return new Promise((resolve, reject) => {
        mkdirp(dpath)
            .then(() => {
                resolve();
            })
            .catch((err) => {
                reject(err.message);
            });
    });
}
export function mkdirs(dpath) {
    try {
        mkdirp.sync(dpath);
    } catch (err) {
        log(`make_dir_sync:${err}`);
    }
}
export function writeBuffer(fpath, bf) {
    return new Promise((resolve, reject) => {
        mkdirp(path.dirname(fpath))
            .then(() => {
                fs.writeFile(fpath, bf, (err) => {
                    err ? reject(err) : resolve();
                });
            })
            .catch((e) => {
                reject(e);
            });
    });
}
export function writeFileSync(filePath, data) {
    try {
        return fs.writeFileSync(filePath, data, 'utf8');
    } catch (err) {
        return '';
    }
}
export function existsSync(fpath) {
    try {
        return fs.existsSync(fpath);
    } catch (err) {
        return false;
    }
}
export function getAttachName(dir) {
    if (fs.existsSync(dir)) {
        return fs.readdirSync(dir)[0];
    }
    return '';
}
export function getFileStats(fpath) {
    return new Promise((resolve) => {
        fs.stat(fpath, (err, stats) => {
            if (err) {
                resolve(null);
                return;
            }
            resolve(stats);
        });
    });
}

export function readJSON(name, root = false) {
    const data = root
        ? readFileSync(Helper.getRootFolder('json', `${name}.json`), 'utf-8')
        : readFileSync(path.join(__static, `json/${name}.json`), 'utf-8');

    if (!data) return {};

    try {
        return JSON.parse(data);
    } catch (error) {
        log('readJSON:', error);
        return null;
    }
}
export function copyDir(sourceDir, targetDir, targetName) {
    try {
        fs.readdirSync(sourceDir).forEach((fitem) => {
            const spath = path.join(sourceDir, fitem);
            const dpath = path.join(targetDir, fitem);
            const cstat = fs.statSync(spath);

            if (cstat.isFile()) {
                const ext = path.extname(fitem);
                // 第一层目录
                if (/\.hrb$/i.test(ext)) {
                    mkdirp.sync(path.join(targetDir));
                    fs.createReadStream(spath).pipe(fs.createWriteStream(path.join(targetDir, targetName + ext)));
                } else {
                    mkdirp.sync(path.dirname(dpath));
                    fs.copyFileSync(spath, dpath);
                }
            } else {
                copyDir(spath, dpath, targetName);
            }
        });
    } catch (e) {
        log(`copyDir:${e}`);
        console.log(e);
    }
}
export function copyFolder(source, destination, callback) {
    fs.access(destination, fs.constants.F_OK, (err) => {
        if (err) {
            fs.mkdir(destination, { recursive: true }, (error) => {
                if (error) throw error;
                copyFiles(source, destination, callback);
            });
        } else {
            copyFiles(source, destination, callback);
        }
    });
}
export function copyFiles(source, destination, callback) {
    fs.readdir(source, (readErr, files) => {
        if (readErr) throw readErr;
        let pending = files.length;
        if (!pending) {
            callback(null);
            return;
        }
        files.forEach((file) => {
            const sourcePath = path.join(source, file);
            const destinationPath = path.join(destination, file);
            fs.stat(sourcePath, (copyErr, stats) => {
                if (copyErr) throw copyErr;
                if (stats.isDirectory()) {
                    fs.mkdir(destinationPath, { recursive: true }, (error) => {
                        if (error) throw error;
                        copyFiles(sourcePath, destinationPath, () => {
                            if (!--pending) callback(null);
                        });
                    });
                } else {
                    fs.copyFile(sourcePath, destinationPath, (error) => {
                        if (error) throw error;
                        if (!--pending) callback(null);
                    });
                }
            });
        });
    });
}
