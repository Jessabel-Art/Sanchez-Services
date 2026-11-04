<?php
declare(strict_types=1);

namespace SanchezServices\Infra;

use SanchezServices\Config;

/** Email transport. 'smtp' uses PHPMailer (vendored); 'log' writes JSON lines (staging/tests); 'null' drops. */
class Mailer
{
    public function __construct(private Config $config)
    {
    }

    /** @param list<string> $to */
    public function send(array $to, ?string $replyTo, string $subject, ?string $html, ?string $text): void
    {
        $transport = $this->config->string('mail.transport', 'smtp');
        if ($transport === 'null') {
            return;
        }
        if ($transport === 'log') {
            $path = $this->config->string('mail.log_path');
            if ($path === '') {
                throw new \RuntimeException('mail.log_path is required for the log transport.');
            }
            $line = json_encode(compact('to', 'replyTo', 'subject', 'html', 'text') + ['at' => gmdate('c')], JSON_UNESCAPED_SLASHES) . "\n";
            if (file_put_contents($path, $line, FILE_APPEND | LOCK_EX) === false) {
                throw new \RuntimeException('Could not write mail log.');
            }
            return;
        }
        if (!class_exists(\PHPMailer\PHPMailer\PHPMailer::class)) {
            throw new \RuntimeException('PHPMailer is not installed (vendor/ missing).');
        }
        $m = new \PHPMailer\PHPMailer\PHPMailer(true);
        $m->isSMTP();
        $m->Host = $this->config->string('mail.host');
        $m->Port = $this->config->int('mail.port', 587);
        $m->SMTPAuth = $this->config->string('mail.username') !== '';
        $m->Username = $this->config->string('mail.username');
        $m->Password = $this->config->string('mail.password');
        $enc = $this->config->string('mail.encryption', 'tls');
        $m->SMTPSecure = $enc === 'ssl' ? \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS : ($enc === 'tls' ? \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS : '');
        $m->CharSet = 'UTF-8';
        $m->Timeout = 15;
        $m->setFrom($this->config->string('mail.from_address'), $this->config->string('mail.from_name', 'Sanchez Services'));
        foreach ($to as $addr) {
            $m->addAddress($addr);
        }
        if ($replyTo) {
            $m->addReplyTo($replyTo);
        }
        $m->Subject = $subject;
        if ($html !== null && $html !== '') {
            $m->isHTML(true);
            $m->Body = $html;
            $m->AltBody = $text ?? strip_tags($html);
        } else {
            $m->isHTML(false);
            $m->Body = (string) $text;
        }
        $m->send();
    }
}
