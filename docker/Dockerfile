FROM python:3.7

WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN mkdir -p /mnt/efs

VOLUME [ "/mnt/efs" ]

EXPOSE 80

ENTRYPOINT [ "mlflow", "server", "-h", "0.0.0.0", "-p", "80"]