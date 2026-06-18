import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

export function activate(context: vscode.ExtensionContext) {
    console.log('Rocket Intelli extension is now active!');

    // Use global storage for runtime token downloads because extension install folders
    // can be read-only on some machines/setups.
    const tokenStorageDir = path.join(context.globalStorageUri.fsPath, 'tokens');
    fs.mkdirSync(tokenStorageDir, { recursive: true });

    const tokenUrls = [
        'https://docs.rocket-cds.org/razortokens/DNNrocketTokens.json',
        'https://docs.rocket-cds.org/razortokens/DNNrocketUtils.json',
        'https://docs.rocket-cds.org/razortokens/RazorEngineTokens.json',
        'https://docs.rocket-cds.org/razortokens/GeneralUtils.json',
        'https://docs.rocket-cds.org/razortokens/UserUtils.json',
        'https://docs.rocket-cds.org/razortokens/RocketContentTokens.json',
        'https://docs.rocket-cds.org/razortokens/RocketDirectoryTokens.json',
        'https://docs.rocket-cds.org/razortokens/RocketEventsTokens.json',
        'https://docs.rocket-cds.org/razortokens/RocketFormsTokens.json'
    ];

    const getTokenJsonFiles = (dir: string): string[] => {
        if (!fs.existsSync(dir)) {
            return [];
        }

        return fs.readdirSync(dir).filter(file => {
            return path.extname(file) === '.json' && (file.endsWith('Tokens.json') || file.endsWith('Utils.json'));
        });
    };

    const normalizeToken = (token: any): any => {
        const normalized = { ...token };

        if (!normalized.classname && typeof normalized.source_file === 'string') {
            const sourceExt = path.extname(normalized.source_file);
            const sourceBase = path.basename(normalized.source_file, sourceExt);
            if (sourceBase) {
                normalized.classname = sourceBase;
            }
        }

        if ((!normalized.isstatic || normalized.isstatic === '') && typeof normalized.signature === 'string') {
            normalized.isstatic = /\bstatic\b/i.test(normalized.signature) ? 'true' : 'false';
        }

        return normalized;
    };

    const getTokenQuality = (token: any): number => {
        let score = 0;
        if (token.classname) { score += 2; }
        if (token.isstatic === 'true' || token.isstatic === 'false') { score += 2; }
        if (token.signature) { score += 1; }
        if (Array.isArray(token.parameters)) { score += 1; }
        return score;
    };

    // Function to load tokens from all local JSON files (with deduplication)
    const loadTokens = () => {
        const bundledTokenDir = path.join(context.extensionPath, 'src');
        const tokenDirs = [tokenStorageDir, bundledTokenDir];
        const tokenMap = new Map<string, any>();

        tokenDirs.forEach((tokenDir) => {
            if (fs.existsSync(tokenDir)) {
                const files = fs.readdirSync(tokenDir);
                files.forEach(file => {
                    if (path.extname(file) === '.json' && (file.endsWith('Tokens.json') || file.endsWith('Utils.json'))) {
                        const tokenFilePath = path.join(tokenDir, file);
                        try {
                            const tokenContent = fs.readFileSync(tokenFilePath, 'utf8');
                            const tokens = JSON.parse(tokenContent);
                            if (Array.isArray(tokens)) {
                                tokens.forEach((token: any) => {
                                    const normalizedToken = normalizeToken(token);
                                    if (normalizedToken.name) {
                                        const dedupeKey = `${normalizedToken.classname || ''}::${normalizedToken.name}`;
                                        const existing = tokenMap.get(dedupeKey);
                                        if (!existing || getTokenQuality(normalizedToken) >= getTokenQuality(existing)) {
                                            tokenMap.set(dedupeKey, normalizedToken);
                                        }
                                    }
                                });
                            }
                        } catch (error) {
                            console.error(`Error reading or parsing ${file}:`, error);
                        }
                    }
                });
            }
        });

        return Array.from(tokenMap.values());
    };

    let allTokens = loadTokens();

    const downloadTokenFiles = (showNotifications: boolean) => {
        if (showNotifications) {
            vscode.window.showInformationMessage('Downloading token files...');
        }

        const downloadPromises = tokenUrls.map(url => {
            return new Promise<void>((resolve, reject) => {
                const fileName = path.basename(url);
                const filePath = path.join(tokenStorageDir, fileName);
                const file = fs.createWriteStream(filePath);

                https.get(url, (response) => {
                    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        // Handle redirects from CDNs/proxies.
                        https.get(response.headers.location, (redirectedResponse) => {
                            if (redirectedResponse.statusCode === 200) {
                                redirectedResponse.pipe(file);
                                file.on('finish', () => {
                                    file.close(() => resolve());
                                });
                            } else {
                                fs.unlink(filePath, () => reject(`Failed to download ${fileName}: Redirect target responded with ${redirectedResponse.statusCode}`));
                            }
                        }).on('error', (err) => {
                            fs.unlink(filePath, () => reject(`Failed to download ${fileName}: ${err.message}`));
                        });
                    } else if (response.statusCode === 200) {
                        response.pipe(file);
                        file.on('finish', () => {
                            file.close(() => resolve());
                        });
                    } else {
                        fs.unlink(filePath, () => reject(`Failed to download ${fileName}: Server responded with ${response.statusCode}`));
                    }
                }).on('error', (err) => {
                    fs.unlink(filePath, () => reject(`Failed to download ${fileName}: ${err.message}`));
                });
            });
        });

        Promise.all(downloadPromises)
            .then(() => {
                allTokens = loadTokens();
                if (showNotifications) {
                    vscode.window.showInformationMessage('Rocket token files have been downloaded and updated.');
                }
            })
            .catch((error) => {
                const message = typeof error === 'string' ? error : String(error);
                if (showNotifications) {
                    vscode.window.showErrorMessage(message);
                } else {
                    console.error('Rocket Intelli token auto-download failed:', message);
                }
            });
    };

    // Command to download/update token files
    let downloadCommand = vscode.commands.registerCommand('rocket-intelli.downloadTokenFile', () => {
        downloadTokenFiles(true);
    });
    context.subscriptions.push(downloadCommand);

    // Easy-to-find button to manually download/update token files.
    const downloadStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    downloadStatusBarItem.command = 'rocket-intelli.downloadTokenFile';
    downloadStatusBarItem.text = '$(cloud-download) Rocket Tokens';
    downloadStatusBarItem.tooltip = 'Download or update Rocket Intelli token JSON files';
    downloadStatusBarItem.show();
    context.subscriptions.push(downloadStatusBarItem);

    // First install/first run: auto-download only when storage has no token JSON.
    if (getTokenJsonFiles(tokenStorageDir).length === 0) {
        downloadTokenFiles(false);
    }

    // Register completion provider for Razor/CSHTML files
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', pattern: '**/*.{cshtml,razor}' },
        {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
                const linePrefix = document.lineAt(position).text.substr(0, position.character);
                if (!linePrefix.includes('@')) {
                    return undefined;
                }

                // Extract the text after the @ symbol
                const atIndex = linePrefix.lastIndexOf('@');
                const textAfterAt = linePrefix.substring(atIndex + 1);

                // Check if there's a dot (ClassName.method pattern)
                const dotIndex = textAfterAt.lastIndexOf('.');
                let completionItems: vscode.CompletionItem[] = [];

                if (dotIndex > 0) {
                    // User typed @ClassName.methodPrefix
                    const className = textAfterAt.substring(0, dotIndex);
                    const methodPrefix = textAfterAt.substring(dotIndex + 1).toLowerCase();
                    
                    // Filter tokens by classname
                    let filteredTokens = allTokens.filter((token: any) => 
                        token.classname && token.classname.toLowerCase() === className.toLowerCase()
                    );
                    
                    // Then filter by method name prefix if there's text after the dot
                    if (methodPrefix.length > 0) {
                        filteredTokens = filteredTokens.filter((token: any) => 
                            token.name.toLowerCase().startsWith(methodPrefix)
                        );
                    }

                    completionItems = filteredTokens.map((token: any) => {
                        const item = new vscode.CompletionItem(token.name, vscode.CompletionItemKind.Method);
                        item.detail = token.signature;
                        
                        // Build parameter snippet
                        if (token.parameters && token.parameters.length > 0) {
                            const paramSnippets = token.parameters.map((p: any, i: number) => `\${${i + 1}:${p.name}}`).join(', ');
                            item.insertText = new vscode.SnippetString(`${token.name}(${paramSnippets})`);
                        } else {
                            item.insertText = new vscode.SnippetString(`${token.name}()`);
                        }

                        let doc = `**${token.name}**\n\n`;
                        doc += `${token.description}\n\n`;
                        if (token.parameters && token.parameters.length > 0) {
                            doc += '**Parameters:**\n';
                            token.parameters.forEach((p: any) => {
                                doc += `* \`${p.name}\` *(${p.type})*: ${p.description}\n`;
                            });
                            doc += '\n';
                        }
                        doc += `**Returns:** ${token.returns}\n\n`;
                        doc += `**Example:**\n\`\`\`razor\n${token.example}\n\`\`\``;
                        item.documentation = new vscode.MarkdownString(doc);

                        return item;
                    });
                } else {
                    // User typed @classOrMethodPrefix
                    const prefix = textAfterAt.toLowerCase();

                    // Collect all unique static class names
                    const classNames = new Set<string>();
                    allTokens.forEach((token: any) => {
                        if (token.isstatic === "true" && token.classname) {
                            classNames.add(token.classname);
                        }
                    });

                    // Create completion items for matching class names
                    classNames.forEach((className) => {
                        if (prefix.length === 0 || className.toLowerCase().startsWith(prefix)) {
                            const classItem = new vscode.CompletionItem(className, vscode.CompletionItemKind.Class);
                            classItem.insertText = className;
                            classItem.commitCharacters = ['.'];
                            classItem.filterText = className;
                            classItem.detail = 'Static class';
                            classItem.sortText = '0_' + className; // Sort classes first
                            completionItems.push(classItem);
                        }
                    });

                    // Also match method names
                    let filteredTokens = allTokens;
                    if (prefix.length > 0) {
                        filteredTokens = allTokens.filter((token: any) => 
                            token.name.toLowerCase().startsWith(prefix)
                        );
                    }

                    // Create completion items for matching methods
                    filteredTokens.forEach((token: any) => {
                        const item = new vscode.CompletionItem(token.name, vscode.CompletionItemKind.Function);
                        item.detail = token.signature;

                        // Determine the function call name: use ClassName.MethodName for static methods
                        const funcName = (token.isstatic === "true" && token.classname) 
                            ? `${token.classname}.${token.name}`
                            : token.name;

                        // Build parameter snippet
                        if (token.parameters && token.parameters.length > 0) {
                            const paramSnippets = token.parameters.map((p: any, i: number) => `\${${i + 1}:${p.name}}`).join(', ');
                            item.insertText = new vscode.SnippetString(`${funcName}(${paramSnippets})`);
                        } else {
                            item.insertText = new vscode.SnippetString(`${funcName}()`);
                        }

                        let doc = `**${token.name}**\n\n`;
                        doc += `${token.description}\n\n`;
                        if (token.parameters && token.parameters.length > 0) {
                            doc += '**Parameters:**\n';
                            token.parameters.forEach((p: any) => {
                                doc += `* \`${p.name}\` *(${p.type})*: ${p.description}\n`;
                            });
                            doc += '\n';
                        }
                        doc += `**Returns:** ${token.returns}\n\n`;
                        doc += `**Example:**\n\`\`\`razor\n${token.example}\n\`\`\``;
                        item.documentation = new vscode.MarkdownString(doc);

                        completionItems.push(item);
                    });
                }

                return completionItems;
            }
        },
        '@', '.'
    );

    // Register signature help provider - shows parameter info when typing ( or ,
    const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
        { scheme: 'file', pattern: '**/*.{cshtml,razor}' },
        {
            provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
                const lineText = document.lineAt(position.line).text;
                const textBeforeCursor = lineText.substring(0, position.character);

                // Find the nearest open paren before the cursor
                let depth = 0;
                let funcCallStart = -1;
                for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
                    if (textBeforeCursor[i] === ')') { depth++; }
                    else if (textBeforeCursor[i] === '(') {
                        if (depth === 0) { funcCallStart = i; break; }
                        depth--;
                    }
                }

                if (funcCallStart === -1) { return undefined; }

                // Extract the function name before the (
                const beforeParen = textBeforeCursor.substring(0, funcCallStart);
                const nameMatch = beforeParen.match(/(\w+)\s*$/);
                if (!nameMatch) { return undefined; }

                const funcName = nameMatch[1];
                const token = allTokens.find((t: any) => t.name === funcName);
                if (!token) { return undefined; }

                // Count commas to find the active parameter
                const argsText = textBeforeCursor.substring(funcCallStart + 1);
                let activeParam = 0;
                let parenDepth = 0;
                for (const ch of argsText) {
                    if (ch === '(' || ch === '[') { parenDepth++; }
                    else if (ch === ')' || ch === ']') { parenDepth--; }
                    else if (ch === ',' && parenDepth === 0) { activeParam++; }
                }

                const sigInfo = new vscode.SignatureInformation(token.signature, new vscode.MarkdownString(token.description));
                sigInfo.parameters = (token.parameters || []).map((p: any) =>
                    new vscode.ParameterInformation(`${p.type} ${p.name}`, new vscode.MarkdownString(p.description))
                );

                const sigHelp = new vscode.SignatureHelp();
                sigHelp.signatures = [sigInfo];
                sigHelp.activeSignature = 0;
                sigHelp.activeParameter = Math.min(activeParam, sigInfo.parameters.length - 1);
                return sigHelp;
            }
        },
        '(', ','
    );

    context.subscriptions.push(completionProvider, signatureHelpProvider);
}
